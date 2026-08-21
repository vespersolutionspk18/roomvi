/**
 * POST /api/images/[id]/analyze — queue surface segmentation.
 * GET  /api/images/[id]/analyze — poll its progress.
 *
 * Returns 202 with the job id rather than doing the work inline. Seven sequential
 * fal calls take 30-90s, which is far past any sensible request timeout, and a
 * route handler that dies mid-flight would abandon calls already paid for. The
 * worker owns the work; this route only asks for it.
 *
 * The idempotency key is the whole reason a double-click is safe: it is derived
 * from the image id, so two concurrent POSTs insert ONE job. Without it the
 * second click buys a second set of seven masks.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { images, jobs, surfaces } from "@/lib/db/schema";
import { enqueue } from "@/lib/queue";

export async function POST(request: Request, ctx: RouteContext<"/api/images/[id]/analyze">) {
  const { id } = await ctx.params;

  const image = await db.query.images.findFirst({ where: eq(images.id, id) });
  if (!image) {
    return Response.json({ error: { code: "not_found", message: "Image not found." } }, { status: 404 });
  }

  // `?force=1` re-segments an already-analyzed photo. Costs another ~$0.035, so
  // it is opt-in and never the retry path.
  const force = new URL(request.url).searchParams.get("force") === "1";

  if (image.analyzedAt && !force) {
    const existing = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, id) });
    return Response.json({
      status: "ready",
      alreadyAnalyzed: true,
      surfaceCount: existing.length,
    });
  }

  const { job, created } = await enqueue({
    kind: "analyze",
    payload: { imageId: id, ...(force ? { force: true } : {}) },
    // Segmentation gates the whole editor, so it outranks renders in the queue.
    priority: 5,
    // A `force` re-run needs its own key or it would collide with the original
    // job forever and silently never run.
    idempotencyKey: force ? `analyze:${id}:force:${Date.now()}` : `analyze:${id}`,
  });

  return Response.json(
    { status: "queued", jobId: job.id, created },
    { status: 202 },
  );
}

export async function GET(_request: Request, ctx: RouteContext<"/api/images/[id]/analyze">) {
  const { id } = await ctx.params;

  const image = await db.query.images.findFirst({ where: eq(images.id, id) });
  if (!image) {
    return Response.json({ error: { code: "not_found", message: "Image not found." } }, { status: 404 });
  }

  const found = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, id) });
  if (image.analyzedAt) {
    return Response.json({
      status: "ready",
      analyzedAt: image.analyzedAt,
      surfaceCount: found.length,
    });
  }

  // Newest first: a `force` re-run is the job the caller is waiting on.
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, "analyze")))
    .orderBy(asc(jobs.createdAt))
    .limit(50)
    .then((rows) => rows.filter((r) => r.payload?.imageId === id).reverse());

  if (!job) return Response.json({ status: "not_started" });

  if (job.status === "dead") {
    return Response.json({
      status: "failed",
      // Surfaced deliberately: an analyze failure is usually a bad photo or an
      // expired fal key, and both are actionable by the person looking at it.
      error: job.lastError,
      attempts: job.attempts,
    });
  }

  return Response.json({
    status: job.status === "running" ? "running" : "queued",
    jobId: job.id,
    attempts: job.attempts,
  });
}
