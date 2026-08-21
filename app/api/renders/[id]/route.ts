/**
 * GET /api/renders/[id] — poll one render.
 *
 * Polled rather than streamed. SSE was the plan's sketch, but a render emits about
 * four meaningful state changes over 30-90s, and an EventSource held open through
 * Next's dev hot-reload drops silently while the client sits waiting for an event
 * that will never arrive. Polling every 1.5s is 40 cheap requests and cannot get
 * stuck in that state.
 *
 * The drift score is exposed deliberately. When the structure guard flags a
 * render, the honest move is to hand it over with the warning attached rather than
 * to hide it or to silently pay for a retry.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, projects, renderOps, renders } from "@/lib/db/schema";
import { FLUX_INPAINT } from "@/lib/render/execute";
import { DRIFT_WARN } from "@/lib/render/guard";
import * as storage from "@/lib/storage";
import { resolveUser } from "@/lib/session";

export async function GET(_request: Request, ctx: RouteContext<"/api/renders/[id]">) {
  const { id } = await ctx.params;

  const row = await db.query.renders.findFirst({ where: eq(renders.id, id) });
  if (!row) {
    return Response.json(
      { error: { code: "not_found", message: "Render not found." } },
      { status: 404 },
    );
  }

  const ops = await db
    .select()
    .from(renderOps)
    .where(eq(renderOps.renderId, id))
    .orderBy(asc(renderOps.seq));

  // The job carries what the render row cannot: attempt count, and the queue's
  // own error text when a handler threw before the row could be updated.
  // Filtered in JS because `payload->>renderId` has no index — the table is small
  // and bounded by the limit, so a scan here is cheaper than an index to maintain.
  const [renderJob] = await db
    .select({
      status: jobs.status,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
      payload: jobs.payload,
    })
    .from(jobs)
    .where(eq(jobs.kind, "render"))
    .orderBy(asc(jobs.createdAt))
    .limit(200)
    .then((rows) => rows.filter((r) => r.payload?.renderId === id).reverse());

  const drift = row.driftScore;

  /**
   * Was the output composited back through the mask?
   *
   * Derived rather than stored, from the two facts that decide it in `execute`: the
   * inpaint endpoint, and at least one op with a surface. It matters here because
   * the drift score is measured on what the MODEL returned, and a composited render
   * discarded that drift — so the same number means two different things and must
   * not produce the same sentence.
   */
  const composited = row.model === FLUX_INPAINT && ops.some((o) => o.surfaceId);

  const flagged = drift != null && drift > DRIFT_WARN;

  return Response.json({
    id: row.id,
    status: row.status,
    executor: row.executor,
    url: row.outputKey ? `/api/files/${row.outputKey}` : null,
    width: row.width,
    height: row.height,
    model: row.model,
    seed: row.seed,
    costUnits: row.costUnits,
    driftScore: drift,
    /**
     * A single sentence the UI can show verbatim. Phrased as "worth comparing"
     * rather than "failed", because a flagged render is often still the one the
     * user wants — they just deserve to know before they trust it.
     *
     * Two sentences, because there are two situations. On a composited render the
     * drift was measured on the model's output and then discarded by the composite,
     * so the shipped image is sound and the honest note is about the SURFACE, whose
     * lighting came from a model that was drifting. Telling that user to compare the
     * whole room would send them looking for damage that was already undone.
     */
    driftWarning: !flagged
      ? null
      : composited
        ? "The model shifted this room's lighting more than expected. Everything outside the surface was restored from your photo, so only the new surface carries that — check it still looks lit like the rest of the room."
        : "This render changed more of the room than expected — compare it against the original before you trust it.",
    error: row.errorMessage,
    errorCode: row.errorCode,
    /**
     * The Precision executor's self-measurement, or null.
     *
     * Served as stored, not recomputed. It describes what the render sitting on disk
     * actually did; re-deriving it from the surface's plane would answer a different
     * question — what a render would do now, with whatever the quad has since been
     * dragged to. A trust feature that silently re-measures is not a trust feature.
     */
    measurement: row.measurement ?? null,
    attempts: renderJob?.attempts ?? 0,
    /**
     * Surfaced so a dead queue is distinguishable from a slow model — but only
     * while the ROW is not yet terminal.
     *
     * A render can be `ready` with a dead-lettered job behind it: the work
     * succeeded, the bookkeeping UPDATE threw, and `scripts/render-recover.ts`
     * later wrote the row from the output already on disk. The job stays dead
     * forever because it genuinely did exhaust its attempts. Reporting that
     * alongside a finished render hands the client a failure signal for a render
     * the user is looking at, and the only reason nothing broke is that
     * `useRender` happens to test `status === "ready"` first. The row is the
     * source of truth about the render; the queue is only evidence about a render
     * still in flight.
     */
    queueStatus: row.status === "ready" ? null : (renderJob?.status ?? null),
    queueError:
      row.status !== "ready" && renderJob?.status === "dead" ? renderJob.lastError : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    ops: ops.map((o) => ({
      seq: o.seq,
      kind: o.kind,
      surfaceId: o.surfaceId,
      materialId: o.materialId,
      prompt: o.prompt,
    })),
  });
}

/**
 * DELETE /api/renders/[id] — remove a version.
 *
 * Ownership flows render -> project -> user, the same chain every other
 * render-scoped route trusts. The row goes first (ops cascade with it); the
 * output file is removed best-effort after, because an orphaned file is garbage
 * while a row pointing at a missing file is a broken editor.
 */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/renders/[id]">) {
  const { id } = await ctx.params;
  const user = await resolveUser();

  const row = await db.query.renders.findFirst({ where: eq(renders.id, id) });
  if (!row) {
    return Response.json(
      { error: { code: "not_found", message: "Render not found." } },
      { status: 404 },
    );
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, row.projectId),
  });
  if (!project || project.userId !== user.id) {
    return Response.json(
      { error: { code: "forbidden", message: "That render is not yours." } },
      { status: 403 },
    );
  }

  // A render still in flight belongs to a live job; deleting it would have the
  // worker write a row (and charge for a fal call) nothing references anymore.
  // Refuse rather than race — the user can cancel-then-delete later if needed.
  if (row.status === "queued" || row.status === "running") {
    return Response.json(
      { error: { code: "in_flight", message: "That render is still being made — wait for it to finish." } },
      { status: 409 },
    );
  }

  await db.delete(renders).where(eq(renders.id, id));
  if (row.outputKey) {
    await storage.remove(row.outputKey);
  }

  return Response.json({ deleted: id });
}
