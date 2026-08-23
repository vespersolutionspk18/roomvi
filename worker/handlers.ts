/**
 * Job handlers.
 *
 * Every handler must be IDEMPOTENT. A worker killed after doing the work but
 * before `complete()` will have its lease reaped and the job re-run, so a
 * handler that appends rather than upserts will duplicate on every crash.
 *
 * Handlers throw `PermanentError` for input that will never succeed (missing
 * row, unsupported format) so the queue dead-letters immediately instead of
 * burning three attempts and, on paid endpoints, three charges.
 */
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { estimateAreaM2, analyzePhoto, normalizedBbox } from "@/lib/analyze";
import { db } from "@/lib/db";
import {
  images,
  materials,
  renderOps,
  renders,
  surfaces,
  type Job,
} from "@/lib/db/schema";
import { encodeMask } from "@/lib/mask";
import { heartbeat } from "@/lib/queue";
import { execute, type RenderOp } from "@/lib/render/execute";
import { measurementSummary, runPrecision, tileSpecFor } from "@/lib/render/precision";
import { RECIPES } from "@/lib/segment";
import * as storage from "@/lib/storage";
import { buildMips } from "@/lib/textures";
import { PermanentError } from "./errors";

export type HandlerContext = { workerId: string };
export type Handler = (job: Job, ctx: HandlerContext) => Promise<void>;

/**
 * Build a material's mip pyramid. Runs on ingest of a new texture.
 *
 * Idempotent: writes to deterministic keys and overwrites. Re-running produces
 * byte-identical output.
 */
const mipmap: Handler = async (job) => {
  const sku = job.payload.sku;
  if (typeof sku !== "string") {
    throw new PermanentError("mipmap: payload.sku must be a string");
  }

  const material = await db.query.materials.findFirst({
    where: eq(materials.sku, sku),
  });
  if (!material) throw new PermanentError(`mipmap: no material with sku '${sku}'`);
  if (!material.textureKey) {
    throw new PermanentError(`mipmap: material '${sku}' has no texture`);
  }

  const base = await storage.get(material.textureKey);
  const levels = await buildMips(base);

  for (const [level, buf] of levels.entries()) {
    await storage.put(storage.keys.materialMip(sku, level), buf);
  }

  await db
    .update(materials)
    .set({
      mipLevels: levels.length - 1,
      // Precision mode needs a texture AND real tile dimensions. Recomputed here
      // rather than trusted, because a texture can be replaced at any time.
      precisionReady: Boolean(material.tileWMm && material.tileHMm),
    })
    .where(eq(materials.sku, sku));
};

/**
 * Segment a photo into surfaces and store their masks.
 *
 * Idempotent by DELETING this image's fal-sourced surfaces before inserting the
 * new set. Upsert-by-kind would be wrong: a re-run can legitimately produce a
 * different NUMBER of surfaces (one endpoint failing, or a subset requested), and
 * merging would leave a stale mask from the previous run alongside the new ones.
 *
 * Brush-corrected and derived surfaces are deliberately spared — the user's own
 * edits must survive a re-analyze, or a reaped job silently destroys their work.
 *
 * COST DISCIPLINE. Seven fal calls, ~$0.035, per photo. Two guards:
 *   - `analyzedAt` short-circuits a completed analyze, so a duplicate enqueue is
 *     free rather than a second charge.
 *   - `force: true` in the payload overrides it, for re-running after a bad
 *     result. It is not the default, because a retry loop with it on is an
 *     invoice.
 */
const analyze: Handler = async (job, ctx) => {
  const imageId = job.payload.imageId;
  if (typeof imageId !== "string") {
    throw new PermanentError("analyze: payload.imageId must be a string");
  }
  const force = job.payload.force === true;

  const image = await db.query.images.findFirst({ where: eq(images.id, imageId) });
  if (!image) throw new PermanentError(`analyze: no image '${imageId}'`);
  if (!image.displayKey) {
    throw new PermanentError(`analyze: image '${imageId}' has no display copy`);
  }
  if (!image.displayWidth || !image.displayHeight) {
    throw new PermanentError(`analyze: image '${imageId}' has no display dimensions`);
  }

  if (image.analyzedAt && !force) {
    const already = await db.query.surfaces.findMany({
      where: eq(surfaces.imageId, imageId),
    });
    console.log(
      `[analyze ${imageId}] already analyzed at ${image.analyzedAt.toISOString()}, ` +
        `${already.length} surface(s) — skipping ${RECIPES.length} paid calls`,
    );
    return;
  }

  let display: Buffer;
  try {
    display = await storage.get(image.displayKey);
  } catch {
    // The row exists but its file does not. Retrying cannot conjure the bytes.
    throw new PermanentError(`analyze: display file missing at '${image.displayKey}'`);
  }

  const result = await analyzePhoto(
    display,
    { width: image.displayWidth, height: image.displayHeight },
    {
      // Seven sequential fal calls can outlast a 2-minute lease. Renewing between
      // surfaces is what stops the reaper re-running a job that is progressing
      // fine — and re-running it means paying for every mask twice.
      onProgress: async (done, total, kind) => {
        await heartbeat(job.id, ctx.workerId);
        console.log(`[analyze ${imageId}] ${done}/${total} ${kind}`);
      },
    },
  );

  // Write masks to disk BEFORE touching the surfaces table, so no row ever points
  // at a mask that does not exist. Orphaned mask files are harmless garbage; a
  // row with a missing mask breaks the editor.
  //
  // A re-detect keeps hand-corrected surfaces (see the delete below), so a fresh
  // fal mask for a kind the user has already fixed by hand would leave the editor
  // with TWO floor zones — one corrected, one not, indistinguishable in the
  // sidebar and both clickable. The user's work wins, and the paid mask for that
  // kind is dropped rather than shown. This is why re-detect after brushing does
  // not undo the brushing.
  const brushedKinds = new Set(
    (
      await db.query.surfaces.findMany({
        where: and(eq(surfaces.imageId, imageId), eq(surfaces.source, "brush")),
      })
    ).map((s) => s.kind),
  );

  const pending: Array<typeof surfaces.$inferInsert> = [];
  const superseded: string[] = [];
  for (const s of result.surfaces) {
    if (brushedKinds.has(s.kind)) {
      superseded.push(s.kind);
      continue;
    }
    const surfaceId = nanoid();
    const maskKey = storage.keys.surfaceMask(surfaceId);
    await storage.put(maskKey, await encodeMask(s.mask));

    const area = estimateAreaM2(s.kind, s.stats.coverage);
    pending.push({
      id: surfaceId,
      imageId,
      kind: s.kind,
      label: s.label,
      maskKey,
      bbox: normalizedBbox(s.stats),
      confidence: s.confidence,
      source: "fal",
      areaM2Low: area?.low ?? null,
      areaM2High: area?.high ?? null,
    });
  }

  await db.transaction(async (tx) => {
    // Only this run's provenance. A brush-corrected surface is the user's work.
    await tx
      .delete(surfaces)
      .where(and(eq(surfaces.imageId, imageId), eq(surfaces.source, "fal")));
    if (pending.length > 0) await tx.insert(surfaces).values(pending);
    await tx.update(images).set({ analyzedAt: new Date() }).where(eq(images.id, imageId));
  });

  const usable = result.surfaces.filter((s) => s.usable).length;
  if (superseded.length > 0) {
    console.log(
      `[analyze ${imageId}] kept hand-corrected ${superseded.join(", ")} ` +
        `— discarded the fresh fal mask for ${superseded.length === 1 ? "it" : "those"}`,
    );
  }
  console.log(
    `[analyze ${imageId}] ${usable}/${result.surfaces.length} usable, ` +
      `${result.failures.length} failed, ${result.costUnits} billable unit(s), ` +
      `${(result.ms / 1000).toFixed(1)}s`,
  );
  for (const f of result.failures) {
    console.warn(`[analyze ${imageId}] ${f.kind} failed: ${f.error}`);
  }

  // Every surface failing is a real failure — a fal outage or a bad key — and
  // must not be recorded as a successful analyze that found nothing.
  if (result.surfaces.length === 0) {
    throw new Error(
      `analyze: all ${result.failures.length} surface(s) failed — ` +
        (result.failures[0]?.error ?? "no detail"),
    );
  }
};

/**
 * Execute a render.
 *
 * Idempotent in the way that matters for a PAID endpoint: if the row already has
 * a `falRequestId`, the work was already submitted and is already billed, so a
 * re-run RE-POLLS that id instead of submitting again. `execute` persists the id
 * through `onSubmitted` before it waits, which is what makes that possible.
 *
 * A render that reaches `ready` is never re-run — the terminal check short-
 * circuits, exactly as `analyzedAt` does for analyze.
 *
 * Every failure path marks the ROW, not only the job. The queue's own bookkeeping
 * is invisible to the editor, and a render stuck at `running` forever is a spinner
 * the user cannot escape.
 */
const render: Handler = async (job, ctx) => {
  const renderId = job.payload.renderId;
  if (typeof renderId !== "string") {
    throw new PermanentError("render: payload.renderId must be a string");
  }
  try {
    await runRender(renderId, job, ctx);
  } catch (err) {
    const permanent = err instanceof PermanentError;
    const lastAttempt = job.attempts + 1 >= job.maxAttempts;
    // Only a terminal outcome writes `failed`. Mid-retry the row stays `running`,
    // because it genuinely is about to run again and telling the user otherwise
    // would make a recoverable blip look like a dead render.
    if (permanent || lastAttempt) {
      await db
        .update(renders)
        .set({
          status: "failed",
          errorCode: permanent ? "permanent" : "exhausted",
          errorMessage: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
        })
        .where(eq(renders.id, renderId))
        .catch((e) => console.error(`[render ${renderId}] could not mark failed`, e));
    }
    throw err;
  }
};

/**
 * The Precision render handler.
 *
 * Structurally simpler than the generative one and for a reason worth stating: there
 * is no fal call, so there is no request id to persist before waiting, no resume path,
 * no double-charge to avoid, and no drift guard to run — the executor's own
 * `outsideUntouched` is a stronger statement than any pHash comparison, because it is
 * exact rather than perceptual.
 *
 * It is also FREE, which changes the failure policy: a Precision failure should be
 * retried freely where a generative one must not be. Everything that can go wrong here
 * (missing plane, missing texture, degenerate homography) is permanent, so the retry
 * budget is spent on transient disk errors only.
 *
 * EXACTLY ONE MATERIAL OP. Two Precision ops in one render would be two independent
 * warps over the same photo, and the second would overwrite the first's composite
 * rather than adding to it. The route enqueues one op per Precision render; this
 * enforces it rather than trusting it.
 */
async function runPrecisionRender(
  renderId: string,
  row: typeof renders.$inferSelect,
  job: Job,
  ctx: HandlerContext,
): Promise<void> {
  const image = await db.query.images.findFirst({ where: eq(images.id, row.baseImageId) });
  if (!image?.displayKey || !image.displayWidth || !image.displayHeight) {
    throw new PermanentError(`render: base image '${row.baseImageId}' has no display copy`);
  }

  const opRows = await db
    .select()
    .from(renderOps)
    .where(eq(renderOps.renderId, renderId))
    .orderBy(asc(renderOps.seq));
  const material_ops = opRows.filter((o) => o.kind === "material");
  if (material_ops.length !== 1) {
    throw new PermanentError(
      `render: precision needs exactly one material op, got ${material_ops.length}`,
    );
  }
  const op = material_ops[0];
  if (!op.surfaceId || !op.materialId) {
    throw new PermanentError(`render: precision op ${op.seq} needs a surface and a material`);
  }

  const surface = await db.query.surfaces.findFirst({ where: eq(surfaces.id, op.surfaceId) });
  if (!surface) throw new PermanentError(`render: missing surface ${op.surfaceId}`);
  const material = await db.query.materials.findFirst({ where: eq(materials.id, op.materialId) });
  if (!material) throw new PermanentError(`render: missing material ${op.materialId}`);

  // Every other zone on this image, so furniture standing on the surface can be cut
  // out of it. Loaded here rather than inside the executor because it is a database
  // question, and lib/precision stays free of DB imports so the browser can run it.
  const siblings = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, image.id) });

  await db
    .update(renders)
    .set({
      status: "running",
      startedAt: row.startedAt ?? new Date(),
      errorCode: null,
      errorMessage: null,
    })
    .where(eq(renders.id, renderId));

  const photo = await storage.get(image.displayKey);
  const result = await runPrecision({
    photo,
    surface,
    material,
    siblings,
    loadMask: (key) => storage.get(key),
    loadTexture: (key) => storage.get(key),
    groutRgb: Array.isArray(op.params?.groutRgb)
      ? (op.params.groutRgb as [number, number, number])
      : undefined,
    onProgress: async (note) => {
      await heartbeat(job.id, ctx.workerId);
      console.log(`[render ${renderId}] ${note}`);
    },
  });

  // A Precision render that touched a pixel outside the mask is a BUG in the warp,
  // not a poor result, and shipping it would put the executor's central guarantee in
  // doubt for every render after it. Permanent, so it dead-letters and gets looked at.
  if (!result.check.outsideUntouched) {
    throw new PermanentError("render: precision altered pixels outside the mask");
  }
  // The partner check. All-zero alpha silently satisfies the one above, which is
  // exactly how a no-op composite once passed an entire suite.
  if (result.check.changedInside < 0.5) {
    throw new PermanentError(
      `render: precision painted only ${(result.check.changedInside * 100).toFixed(1)}% of the region`,
    );
  }

  const plane = surface.plane;
  if (!plane) throw new PermanentError("render: surface lost its plane mid-render");
  const tile = tileSpecFor(material, plane.theta ?? 0);
  const summary = measurementSummary(result.check, tile, plane);

  const outputKey = storage.keys.renderOutput(renderId);
  await storage.put(outputKey, result.output);

  await db
    .update(renders)
    .set({
      status: "ready",
      outputKey,
      width: image.displayWidth,
      height: image.displayHeight,
      // Not a fal endpoint. Named so the history list can say what produced a render
      // without a second lookup, and so `resume` can never mistake it for one.
      model: "precision/warp",
      // Zero, not null. Null reads as "unknown cost" in a reconciliation; zero is the
      // actual number and the whole margin argument for this mode.
      costUnits: 0,
      // Bit-equality outside the mask was just asserted above, so this is exact
      // rather than a perceptual score that happens to be small.
      driftScore: 0,
      measurement: {
        residualPx: result.check.residualPx,
        tilesAcross: result.check.tilesAcross,
        tilesDown: result.check.tilesDown,
        expectedAcross: result.check.expectedAcross,
        expectedDown: result.check.expectedDown,
        painted: result.check.painted,
        outsideUntouched: result.check.outsideUntouched,
        changedInside: result.check.changedInside,
        tile: {
          widthMm: tile.tileWMm,
          heightMm: tile.tileHMm,
          groutMm: tile.groutMm,
          bond: tile.bond,
          thetaDeg: (tile.theta * 180) / Math.PI,
        },
        headline: summary.headline,
        verified: summary.verified,
        lines: summary.lines,
      },
      completedAt: new Date(),
    })
    .where(eq(renders.id, renderId));

  console.log(
    `[render ${renderId}] precision ready in ${(result.ms / 1000).toFixed(1)}s — ` +
      `${tile.tileWMm}x${tile.tileHMm}mm ${tile.bond}, ` +
      `${result.check.tilesAcross}x${result.check.tilesDown} courses, ` +
      `${(result.check.painted * 100).toFixed(1)}% painted, ` +
      `${result.occluders.length} occluder(s), $0.00 — ${summary.headline}`,
  );
}

async function runRender(renderId: string, job: Job, ctx: HandlerContext): Promise<void> {
  const row = await db.query.renders.findFirst({ where: eq(renders.id, renderId) });
  if (!row) throw new PermanentError(`render: no render '${renderId}'`);

  if (row.status === "ready" && row.outputKey) {
    console.log(`[render ${renderId}] already ready — skipping a paid call`);
    return;
  }
  if (row.status === "cancelled") {
    console.log(`[render ${renderId}] cancelled before it ran`);
    return;
  }
  if (row.executor === "precision") {
    await runPrecisionRender(renderId, row, job, ctx);
    return;
  }
  if (row.executor !== "generative") {
    throw new PermanentError(`render: executor '${row.executor}' is not implemented`);
  }

  const image = await db.query.images.findFirst({ where: eq(images.id, row.baseImageId) });
  if (!image?.displayKey || !image.displayWidth || !image.displayHeight) {
    throw new PermanentError(`render: base image '${row.baseImageId}' has no display copy`);
  }

  const opRows = await db
    .select()
    .from(renderOps)
    .where(eq(renderOps.renderId, renderId))
    .orderBy(asc(renderOps.seq));
  if (opRows.length === 0) throw new PermanentError(`render: '${renderId}' has no ops`);

  // Resolve every op to the surfaces and materials it references. Done up front
  // so a missing row is a permanent failure BEFORE any money is spent.
  const ops: RenderOp[] = [];
  for (const op of opRows) {
    const surface = op.surfaceId
      ? await db.query.surfaces.findFirst({ where: eq(surfaces.id, op.surfaceId) })
      : null;
    if (op.surfaceId && !surface) {
      throw new PermanentError(`render: op ${op.seq} references missing surface ${op.surfaceId}`);
    }

    if (op.kind === "material") {
      if (!op.materialId) throw new PermanentError(`render: material op ${op.seq} has no material`);
      if (!surface) throw new PermanentError(`render: material op ${op.seq} has no surface`);
      const material = await db.query.materials.findFirst({
        where: eq(materials.id, op.materialId),
      });
      if (!material) {
        throw new PermanentError(`render: op ${op.seq} references missing material ${op.materialId}`);
      }
      ops.push({
        kind: "material",
        surface: {
          id: surface.id,
          kind: surface.kind,
          label: surface.label ?? surface.kind,
          maskKey: surface.maskKey,
        },
        material: {
          id: material.id,
          name: material.name,
          category: material.category,
          finish: material.finish,
          tileWMm: material.tileWMm,
          tileHMm: material.tileHMm,
          textureKey: material.textureKey,
        },
        strength: typeof op.params?.strength === "number" ? op.params.strength : undefined,
      });
    } else {
      if (!op.prompt) throw new PermanentError(`render: prompt op ${op.seq} has no prompt`);
      // Reference keys arrive in params, validated as strings — a malformed key
      // fails the storage read below, before anything is uploaded or charged.
      const references = Array.isArray(op.params?.references)
        ? (op.params.references as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      const maskKey =
        typeof op.params?.maskKey === "string" && op.params.maskKey.length > 0
          ? op.params.maskKey
          : undefined;
      ops.push({
        kind: "prompt",
        prompt: op.prompt,
        surface: surface
          ? {
              id: surface.id,
              kind: surface.kind,
              label: surface.label ?? surface.kind,
              maskKey: surface.maskKey,
            }
          : null,
        ...(references.length ? { references } : {}),
        ...(maskKey ? { paintMaskKey: maskKey } : {}),
      });
    }
  }

  await db
    .update(renders)
    .set({ status: "running", startedAt: row.startedAt ?? new Date(), errorCode: null, errorMessage: null })
    .where(eq(renders.id, renderId));

  // WHICH pixels the edit starts from. Default: the original photo — a fresh
  // sentence about "the kitchen" means THE kitchen. When the payload carries a
  // base render, that version's output is the canvas instead: conversational
  // editing, where "make it warmer" builds on what the user is looking at.
  //
  // The base is re-validated here rather than trusted from the route, because a
  // lease reap and a retry can land long after the submit-time checks: a base
  // that went missing, was deleted, or never finished is a PERMANENT input
  // problem, not a transient one worth three attempts.
  let photo: Buffer;
  let sourceNote = "original photo";
  const baseRenderId =
    typeof job.payload.baseRenderId === "string" ? job.payload.baseRenderId : null;
  if (baseRenderId) {
    const base = await db.query.renders.findFirst({
      where: eq(renders.id, baseRenderId),
    });
    if (!base || base.outputKey == null || base.status !== "ready") {
      throw new PermanentError(`render: base '${baseRenderId}' is gone or never finished`);
    }
    if (base.baseImageId !== image.id) {
      throw new PermanentError(`render: base '${baseRenderId}' belongs to a different photo`);
    }
    if (
      !base.width ||
      !base.height ||
      base.width !== image.displayWidth ||
      base.height !== image.displayHeight
    ) {
      throw new PermanentError(
        `render: base '${baseRenderId}' is ${base.width}x${base.height}, expected ${image.displayWidth}x${image.displayHeight}`,
      );
    }
    photo = await storage.get(base.outputKey);
    sourceNote = `version ${baseRenderId}`;
  } else {
    photo = await storage.get(image.displayKey);
  }

  // OUTPAINT spec from the route (validated there; re-checked for shape here
  // because a retry can land long after submit-time checks).
  const p = job.payload.expand as Record<string, unknown> | undefined;
  const expand =
    p &&
    typeof p.left === "number" &&
    typeof p.right === "number" &&
    typeof p.top === "number" &&
    typeof p.bottom === "number" &&
    typeof p.width === "number" &&
    typeof p.height === "number" &&
    p.width <= 6000 &&
    p.height <= 6000
      ? {
          left: p.left,
          right: p.right,
          top: p.top,
          bottom: p.bottom,
          width: p.width,
          height: p.height,
        }
      : undefined;
  if (job.payload.expand && !expand) {
    throw new PermanentError("render: malformed expand payload");
  }

  const result = await execute({
    photo,
    width: image.displayWidth,
    height: image.displayHeight,
    ops,
    loadMask: (key) => storage.get(key),
    loadTexture: (key) => storage.get(key),
    loadReference: (key) => storage.get(key),
    expand,
    seed: row.seed,
    /**
     * The id from a previous attempt, if there was one. THIS is what makes the
     * doc comment above true — without it the stored id was written and never
     * read, and a retry after a successful fal call paid for it again. Measured:
     * one backsplash render billed three times when the success UPDATE threw on
     * a seed that overflowed an `integer` column.
     */
    resume:
      row.falRequestId && row.model
        ? { requestId: row.falRequestId, endpoint: row.model }
        : null,
    // Persisted the moment fal answers, before any waiting. A worker killed
    // during the poll re-enters here, sees the id, and resumes rather than
    // paying twice.
    onSubmitted: async (requestId, endpoint) => {
      await db
        .update(renders)
        .set({ falRequestId: requestId, model: endpoint })
        .where(eq(renders.id, renderId));
      console.log(`[render ${renderId}] submitted ${endpoint} ${requestId}`);
    },
    onProgress: async (note) => {
      await heartbeat(job.id, ctx.workerId);
      console.log(`[render ${renderId}] ${note}`);
    },
  });

  // Output to disk BEFORE the row points at it, same rule as masks: an orphaned
  // file is garbage, a row pointing at a missing file breaks the editor.
  const outputKey = storage.keys.renderOutput(renderId);
  await storage.put(outputKey, result.jpeg);

  await db
    .update(renders)
    .set({
      status: "ready",
      outputKey,
      width: result.width,
      height: result.height,
      model: result.endpoint,
      seed: result.seed,
      costUnits: result.costUnits,
      falRequestId: result.falRequestId,
      driftScore: result.drift?.score ?? null,
      completedAt: new Date(),
    })
    .where(eq(renders.id, renderId));

  console.log(
    `[render ${renderId}] ready in ${(result.ms / 1000).toFixed(1)}s — ` +
      `${result.endpoint}, from ${sourceNote}, ${result.costUnits} unit(s), ` +
      `${result.composited ? "composited" : "whole-image"}, drift ${
        result.drift ? `${result.drift.verdict} (${result.drift.detail})` : "n/a"
      }`,
  );

  // Reported, not retried. A retry is a second charge, and the honest move is to
  // hand the user a render with a visible warning rather than to keep paying
  // until the model happens to behave.
  if (result.drift && result.drift.verdict !== "clean") {
    console.warn(`[render ${renderId}] STRUCTURE GUARD: ${result.drift.detail}`);
  }
}

export const handlers: Record<Job["kind"], Handler> = { analyze, render, mipmap };
