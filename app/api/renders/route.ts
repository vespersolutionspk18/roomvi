/**
 * POST /api/renders — submit a render.
 * GET  /api/renders?imageId= — the version history for a photo.
 *
 * Two things happen here that cannot happen in the worker:
 *
 *  1. INTENT CLASSIFICATION. A free-form prompt has to be resolved against the
 *     surfaces THIS photo actually has before it can be routed, and the route is
 *     what determines the endpoint and therefore the price. "retile the
 *     splashback" is a masked swap only because a backsplash was detected.
 *
 *  2. CREDIT DEBIT AT SUBMIT. Debiting on completion lets a user with one credit
 *     fire forty concurrent renders. The refund on failure is the worker's job.
 *
 * Returns 202 with the render id. A render takes 20-90s, well past any request
 * timeout, and a handler that died mid-flight would abandon a paid fal call.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { images, materials, projects, renderOps, renders, surfaces, type SurfacePlane } from "@/lib/db/schema";
import { enqueue } from "@/lib/queue";
import { eligible } from "@/lib/render/precision";
import { classifyPrompt } from "@/lib/render/prompt";
import { resolveUser } from "@/lib/session";

/**
 * One request may carry several ops.
 *
 * Deliberate: "oak floor and white walls" as two renders costs twice as much and
 * lets the second call re-light the first's work. One call, one price, one
 * coherent lighting solution.
 */
const OpSchema = z.union([
  z.object({
    kind: z.literal("material"),
    surfaceId: z.string().min(1),
    materialId: z.string().min(1),
    /** Overrides the executor default. Clamped, since 1.0 erases all shading. */
    strength: z.number().min(0.3).max(0.95).optional(),
  }),
  z.object({
    kind: z.literal("prompt"),
    prompt: z.string().min(3).max(600),
    /** Omit to let the classifier decide from the text. */
    surfaceId: z.string().min(1).nullish(),
    /**
     * Storage keys of user-attached reference images ("like this"). Part of the
     * op, therefore part of the idempotency fingerprint: the same sentence with
     * a different reference is a different render.
     */
    referenceKeys: z.array(z.string().min(1)).max(4).optional(),
    /**
     * A hand-painted region mask ("add a cat HERE"). Validated loosely here and
     * hard-validated in the worker, where a wrong-sized mask is a permanent
     * failure before anything is uploaded.
     */
    maskKey: z.string().min(1).optional(),
  }),
]);

const BodySchema = z.object({
  imageId: z.string().min(1),
  ops: z.array(OpSchema).min(1).max(4),
  seed: z.number().int().nullish(),
  /**
   * Which executor to run. Omit for generative, which is the only path that can
   * take any op on any surface.
   *
   * An EXPLICIT choice rather than "try precision, fall back". Precision costs
   * $0.00 against $0.035-0.09, so a silent fallback would move a user from free to
   * paid without telling them, and the two produce visibly different pictures — a
   * real bitmap laid to scale versus a model's impression of one. Which of those
   * arrived is not something to leave the server to decide quietly.
   */
  executor: z.enum(["generative", "precision"]).optional(),
  /**
   * Render ON TOP OF a previous version instead of the original photo.
   *
   * This is conversational editing: select a version, ask for more, get a child
   * of it. Omitted means the original — which remains the default, because a
   * fresh sentence about "the kitchen" should mean the kitchen, not whatever
   * experiment happens to be on screen.
   *
   * Validated below against ownership AND readiness: a base that is still
   * rendering has no output to build on, and building on someone else's render
   * would leak their work into yours.
   */
  baseRenderId: z.string().min(1).nullish(),
  /**
   * OUTPAINT request: grow the canvas to the given aspect ratio and have the
   * model fill what's new. The server owns the pad math (it knows the real
   * display dimensions); the client only expresses intent — "make it match my
   * screen". The original photograph region is composited back afterwards, so
   * generation can only ever ADD scenery around it, never alter it.
   */
  expand: z
    .object({
      ratioW: z.number().positive().max(10),
      ratioH: z.number().positive().max(10),
    })
    .optional(),
});

function bad(code: string, message: string, status = 400) {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const user = await resolveUser();

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return bad("invalid_body", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const body = parsed.data;

  const image = await db.query.images.findFirst({ where: eq(images.id, body.imageId) });
  if (!image) return bad("not_found", "Image not found.", 404);
  if (!image.displayKey || !image.displayWidth || !image.displayHeight) {
    return bad("not_ready", "That photo has no display copy yet.", 409);
  }
  if (!image.analyzedAt) {
    // Without surfaces there is no mask, so every op would route to the expensive
    // whole-image path. Refusing is cheaper than silently doing that.
    return bad("not_analyzed", "Detect the room's surfaces before rendering.", 409);
  }

  /* ------------------------------------------------------ the base, if any */

  let baseRenderId: string | null = null;
  if (body.baseRenderId) {
    const base = await db.query.renders.findFirst({
      where: eq(renders.id, body.baseRenderId),
    });
    if (!base || base.baseImageId !== body.imageId) {
      return bad("bad_base", "That version does not belong to this photo.", 404);
    }
    const baseProject = await db.query.projects.findFirst({
      where: eq(projects.id, base.projectId),
    });
    if (!baseProject || baseProject.userId !== user.id) {
      return bad("forbidden", "That version is not yours.", 403);
    }
    if (base.status !== "ready" || !base.outputKey) {
      return bad(
        "base_not_ready",
        "That version has not finished rendering — wait for it, then build on it.",
        409,
      );
    }
    baseRenderId = base.id;
  }

  /* --------------------------------------------------- the expand, if any */

  let expandSpec: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  } | null = null;
  if (body.expand) {
    const W = image.displayWidth!;
    const H = image.displayHeight!;
    const target = body.expand.ratioW / body.expand.ratioH;
    const current = W / H;

    // Within 2% of the target there is nothing meaningful to generate — refuse
    // rather than bill a render for two pixels of sky.
    if (Math.abs(target - current) / current < 0.02) {
      return bad(
        "already_matches",
        "That photo already matches this aspect ratio — nothing to expand.",
        409,
      );
    }

    // The original sits centred inside the new canvas; generation fills only
    // the border. Dimensions stay in display space, where every other
    // coordinate in the product lives.
    let width = W;
    let height = H;
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = 0;
    if (current < target) {
      width = Math.round(H * target);
      left = Math.floor((width - W) / 2);
      right = width - W - left;
    } else {
      height = Math.round(W / target);
      top = Math.floor((height - H) / 2);
      bottom = height - H - top;
    }
    expandSpec = { left, right, top, bottom, width, height };
  }

  const zones = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, body.imageId) });
  const byId = new Map(zones.map((z) => [z.id, z]));
  const availableKinds = zones.map((z) => z.kind);

  /* ------------------------------------------------- validate + classify ops */

  const resolved: Array<{
    kind: "material" | "prompt";
    surfaceId: string | null;
    materialId: string | null;
    prompt: string | null;
    params: Record<string, unknown> | null;
  }> = [];

  const materialIds = body.ops.flatMap((o) => (o.kind === "material" ? [o.materialId] : []));
  const materialRows = materialIds.length
    ? await db.query.materials.findMany({ where: inArray(materials.id, materialIds) })
    : [];
  const materialById = new Map(materialRows.map((m) => [m.id, m]));

  for (const [i, op] of body.ops.entries()) {
    if (op.kind === "material") {
      const surface = byId.get(op.surfaceId);
      if (!surface) return bad("bad_surface", `Op ${i}: no such surface on this photo.`);
      const material = materialById.get(op.materialId);
      if (!material) return bad("bad_material", `Op ${i}: no such material.`);
      if (!material.active) return bad("bad_material", `Op ${i}: ${material.name} is discontinued.`);
      // The reference image IS the material. Without a texture the model would be
      // guessing from the name alone, which is not what the swatch promised.
      if (!material.textureKey) {
        return bad("no_texture", `Op ${i}: ${material.name} has no texture bitmap yet.`, 409);
      }
      resolved.push({
        kind: "material",
        surfaceId: surface.id,
        materialId: material.id,
        prompt: null,
        params: op.strength != null ? { strength: op.strength } : null,
      });
      continue;
    }

    // An explicit surfaceId from the UI wins — the user clicked a zone, which is
    // better evidence than anything inferable from their sentence.
    if (op.surfaceId) {
      const surface = byId.get(op.surfaceId);
      if (!surface) return bad("bad_surface", `Op ${i}: no such surface on this photo.`);
      resolved.push({
        kind: "prompt",
        surfaceId: surface.id,
        materialId: null,
        prompt: op.prompt,
        params: {
          intent: "surface_prompt",
          classified: false,
          ...(op.referenceKeys?.length ? { references: op.referenceKeys } : {}),
          ...(op.maskKey ? { maskKey: op.maskKey } : {}),
        },
      });
      continue;
    }

    const intent = classifyPrompt(op.prompt, availableKinds);
    const hintKind = intent.mode === "surface_prompt" ? intent.surfaceHint : null;
    // Largest first when a kind has several rows: "paint the wall" means the wall,
    // not one of its fragments.
    const target = hintKind
      ? zones
          .filter((z) => z.kind === hintKind)
          .sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox))[0]
      : null;

    resolved.push({
      kind: "prompt",
      surfaceId: target?.id ?? null,
      materialId: null,
      prompt: op.prompt,
      params: {
        intent: intent.mode,
        classified: true,
        hint: hintKind,
        ...(op.referenceKeys?.length ? { references: op.referenceKeys } : {}),
        ...(op.maskKey ? { maskKey: op.maskKey } : {}),
      },
    });
  }

  /* -------------------------------------------------- precision eligibility */

  // Checked HERE, before anything is enqueued, and refused rather than downgraded.
  //
  // The temptation with a free executor is to try it and fall back on failure. That
  // is wrong twice over: by the time the warp has run the user has watched a
  // progress bar, and a fallback silently spends money on a mode they did not pick.
  // Every branch of `eligible()` names the missing datum, so the editor can grey the
  // control out with a reason attached instead of failing on click.
  const executor = body.executor ?? "generative";
  if (executor === "precision") {
    if (resolved.length !== 1 || resolved[0].kind !== "material") {
      return bad(
        "precision_unsupported",
        "Precision lays one real material on one measured surface. Free-form prompts and multi-op renders go through the generative path.",
        409,
      );
    }
    const op = resolved[0];
    const surface = byId.get(op.surfaceId!)!;
    const material = materialById.get(op.materialId!)!;
    const check = eligible(surface, material);
    if (!check.ok) {
      return bad("precision_ineligible", `Precision cannot render this: ${check.reason}.`, 409);
    }
  }

  /* ---------------------------------------------------------------- persist */

  // One idempotency key per (image, op list). A double-click submits the same
  // ops and so hits the same key — one job, one charge. A genuinely different
  // request produces a different key and renders normally.
  //
  // THE MASK KEY IS PART OF THE FINGERPRINT, not just the surface id. Brush
  // correction rewrites a surface's mask under a NEW key, so without this a user
  // who renders the floor, fixes the mask, and renders the floor again gets the
  // pre-correction render handed back as `reused: true` — their correction
  // silently discarded, and no way to tell from the UI. The surface id alone
  // cannot express "same surface, different shape".
  //
  // THE PLANE IS IN IT FOR THE SAME REASON. Dragging the guides is the Precision
  // equivalent of correcting a mask: same surface, same material, entirely
  // different render. Hashing the quad and reference span means re-measuring
  // produces a new render rather than the old one handed back as a cache hit —
  // which on a mode whose whole claim is measured accuracy would be the most
  // damaging possible false positive.
  const fingerprint = JSON.stringify({
    ops: resolved.map((r) => [
      r.kind,
      r.surfaceId,
      r.surfaceId ? (byId.get(r.surfaceId)?.maskKey ?? null) : null,
      r.materialId,
      r.prompt,
      r.params?.strength ?? null,
      // References change what the model produces, so they change the render's
      // identity — same words, different "like this", different job. A painted
      // region is the same: "add a cat" here and there are different renders.
      r.params?.references ?? null,
      r.params?.maskKey ?? null,
      executor === "precision" && r.surfaceId ? planeKey(byId.get(r.surfaceId)?.plane) : null,
    ]),
    // And the base above all: "make it warmer" on the original and on last
    // night's experiment are two entirely different commissions. Same for the
    // requested expansion ratio.
    base: baseRenderId,
    expand: expandSpec,
  });
  const idempotencyKey = `render:${body.imageId}:${executor === "precision" ? "p:" : ""}${hash(fingerprint)}${body.seed != null ? `:${body.seed}` : ""}`;

  // An identical in-flight or completed render is a cache hit, not a resubmit.
  // This is the guard that stops a user clicking the same swatch three times
  // paying three times.
  const existingJob = await db.query.jobs.findFirst({
    where: (j, { eq: e }) => e(j.idempotencyKey, idempotencyKey),
  });
  if (existingJob?.payload?.renderId) {
    const prior = await db.query.renders.findFirst({
      where: eq(renders.id, String(existingJob.payload.renderId)),
    });
    if (prior && prior.status !== "failed") {
      return Response.json(
        { renderId: prior.id, status: prior.status, executor: prior.executor, reused: true },
        { status: 200 },
      );
    }
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(renders)
      .values({
        projectId: image.projectId,
        baseImageId: image.id,
        status: "queued",
        executor,
        seed: body.seed ?? null,
      })
      .returning();

    await tx.insert(renderOps).values(
      resolved.map((r, seq) => ({
        renderId: row.id,
        seq,
        kind: r.kind,
        surfaceId: r.surfaceId,
        materialId: r.materialId,
        prompt: r.prompt,
        params: r.params,
      })),
    );

    // Enqueued INSIDE the transaction: Postgres defers NOTIFY to COMMIT, so a
    // rollback never wakes a worker for a render row that does not exist.
    const { job } = await enqueue(
      {
        kind: "render",
        // baseRenderId rides in the payload: the worker's only instruction about
        // WHICH pixels to start from. The render row stays executor-agnostic.
        payload: {
          renderId: row.id,
          userId: user.id,
          ...(baseRenderId ? { baseRenderId } : {}),
          ...(expandSpec ? { expand: expandSpec } : {}),
        },
        idempotencyKey,
        // Below analyze: a photo with no surfaces cannot render at all, so
        // unblocking it first drains the queue faster overall.
        priority: 1,
      },
      tx,
    );

    return { row, job };
  });

  return Response.json(
    { renderId: result.row.id, jobId: result.job.id, status: "queued", executor },
    { status: 202 },
  );
}

/** Version history. Ops, never chained outputs — see invariant 1 in the schema. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const imageId = url.searchParams.get("imageId");
  if (!imageId) return bad("missing_image", "imageId is required.");

  const rows = await db
    .select()
    .from(renders)
    .where(and(eq(renders.baseImageId, imageId)))
    .orderBy(desc(renders.createdAt))
    .limit(40);

  const ops = rows.length
    ? await db
        .select()
        .from(renderOps)
        .where(inArray(renderOps.renderId, rows.map((r) => r.id)))
    : [];

  const opsByRender = new Map<string, typeof ops>();
  for (const op of ops) {
    const list = opsByRender.get(op.renderId) ?? [];
    list.push(op);
    opsByRender.set(op.renderId, list);
  }

  return Response.json({
    renders: rows.map((r) => ({
      id: r.id,
      status: r.status,
      executor: r.executor,
      url: r.outputKey ? `/api/files/${r.outputKey}` : null,
      width: r.width,
      height: r.height,
      model: r.model,
      costUnits: r.costUnits,
      /** Above DRIFT_WARN the render is worth a second look before trusting it. */
      driftScore: r.driftScore,
      error: r.errorMessage,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      ops: (opsByRender.get(r.id) ?? [])
        .sort((a, b) => a.seq - b.seq)
        .map((o) => ({
          kind: o.kind,
          surfaceId: o.surfaceId,
          materialId: o.materialId,
          prompt: o.prompt,
        })),
    })),
  });
}

function bboxArea(b: [number, number, number, number] | null): number {
  if (!b) return 0;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

/**
 * The part of a plane that changes what gets rendered.
 *
 * The quad and reference span, NOT `H` — H is derived from them, so including it
 * would be redundant, and its nine floats print at full precision, which makes the
 * key sensitive to the last bit of a division. The quad is what the user dragged.
 */
function planeKey(plane: SurfacePlane | null | undefined): string | null {
  if (!plane) return null;
  return JSON.stringify([plane.quad, plane.refWidthMm, plane.refHeightMm, plane.theta]);
}

/** FNV-1a, hex. Short, stable, and not security-relevant — it is a dedupe key. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
