/**
 * PATCH /api/images/[id]/surfaces/[surfaceId] — hand-correct a mask.
 *
 * fal gets roughly 80% of masks usable, which is why this ships in v1 rather than
 * as a nicety. A backsplash mask that spills onto the cabinet doors renders the
 * cabinets in tile; the alternative to a brush is re-analysing at $0.035 a go and
 * hoping, or abandoning the photo.
 *
 * THIS ROUTE MUST NOT TRUST THE CLIENT'S BITMAP. Two ways to build it, and only
 * one is safe:
 *
 *   posting a PNG   -> the client can post ANY mask, including one covering the
 *                      whole frame, and the server has no way to tell a
 *                      correction from a replacement
 *   posting STROKES -> the server re-rasterizes over the mask already on disk, so
 *                      the result is always "the detected surface, edited", and
 *                      the edit is bounded by what a brush can do
 *
 * So strokes. It also makes the payload ~1KB instead of ~200KB, and it is the
 * only version where `lib/editor/brush.ts` running on both sides is a guarantee
 * rather than a coincidence.
 *
 * The mask is REPLACED IN PLACE at a new key, and `source` becomes 'brush'. A new
 * key rather than overwriting, because `/api/files` serves these `immutable` — an
 * overwrite would leave every browser that has seen the old mask showing it
 * forever, which looks exactly like the brush silently not working.
 */
import { and, eq } from "drizzle-orm";
import { estimateAreaM2, normalizedBbox } from "@/lib/analyze";
import { db } from "@/lib/db";
import { images, surfaces } from "@/lib/db/schema";
import { applyStrokes, validateStrokes } from "@/lib/editor/brush";
import { analyzeMask, decodeMask, encodeMask } from "@/lib/mask";
import type { SegmentableKind } from "@/lib/segment";
import * as storage from "@/lib/storage";
import { nanoid } from "nanoid";

function bad(code: string, message: string, status = 400) {
  return Response.json({ error: { code, message } }, { status });
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/images/[id]/surfaces/[surfaceId]">,
) {
  const { id, surfaceId } = await ctx.params;

  const body = (await request.json().catch(() => null)) as { strokes?: unknown } | null;
  if (!body) return bad("invalid_body", "Expected a JSON body.");

  const parsed = validateStrokes(body.strokes);
  if (!parsed.ok) return bad("invalid_strokes", parsed.reason);

  const image = await db.query.images.findFirst({ where: eq(images.id, id) });
  if (!image) return bad("not_found", "Image not found.", 404);
  if (!image.displayWidth || !image.displayHeight) {
    return bad("not_ready", "That photo has no display copy yet.", 409);
  }

  // Scoped to the image, so a surfaceId from another photo is a 404 rather than a
  // cross-photo write.
  const surface = await db.query.surfaces.findFirst({
    where: and(eq(surfaces.id, surfaceId), eq(surfaces.imageId, id)),
  });
  if (!surface) return bad("not_found", "No such surface on this photo.", 404);

  /* ------------------------------------------------------------- rasterize */

  const existing = await decodeMask(await storage.get(surface.maskKey));
  if (existing.width !== image.displayWidth || existing.height !== image.displayHeight) {
    // Strokes are normalized against the DISPLAY box the user painted on. If the
    // stored mask is a different size, "normalized" means two different things on
    // the two sides and the correction lands in the wrong place.
    return bad(
      "size_mismatch",
      `Stored mask is ${existing.width}×${existing.height} but the photo displays at ${image.displayWidth}×${image.displayHeight}.`,
      409,
    );
  }

  const changed = applyStrokes(
    existing.data,
    existing.width,
    existing.height,
    parsed.strokes,
  );
  if (changed === 0) {
    // Not an error: painting inside a region that was already on is a perfectly
    // reasonable thing to do. But writing a new mask key for an identical mask
    // would burn the browser's cache of a file that did not change.
    return Response.json({ surfaceId, changed: 0, unchanged: true }, { status: 200 });
  }

  const stats = analyzeMask(existing);
  if (stats.coverage < 0.001) {
    // A mask this small cannot be rendered — the executor would send fal a mask
    // covering nothing and bill for a no-op. Refusing here is free.
    return bad(
      "erased",
      "That would erase the zone. Use “Re-detect” to start over, or delete the zone.",
      409,
    );
  }

  /* ------------------------------------------------------------ persist */

  // NOT the old key. See the header: /api/files serves masks `immutable`, so
  // reusing the key would leave the old bits cached in every browser that has
  // already loaded this zone.
  const maskKey = storage.keys.surfaceMask(`${surfaceId}-${nanoid(8)}`);
  await storage.put(maskKey, await encodeMask(existing));

  const area = estimateAreaM2(surface.kind as SegmentableKind, stats.coverage);
  const previousKey = surface.maskKey;

  const [updated] = await db
    .update(surfaces)
    .set({
      maskKey,
      // 'brush' is load-bearing beyond bookkeeping: it is what stops the next
      // analyze run silently overwriting hand work, and what the render
      // fingerprint hashes so a corrected mask is a different render.
      source: "brush",
      bbox: normalizedBbox(stats),
      areaM2Low: area?.low ?? null,
      areaM2High: area?.high ?? null,
      // The model's confidence described the model's mask. It no longer applies to
      // a mask a human edited, and leaving it would show "94% match" on a shape
      // fal never produced.
      confidence: null,
      updatedAt: new Date(),
    })
    .where(eq(surfaces.id, surfaceId))
    .returning();

  // After the row, and only on success. Deleting first would strand the zone with
  // a key pointing at nothing if the UPDATE threw; this way the worst case is one
  // orphaned file, which costs disk rather than a broken editor.
  if (previousKey !== maskKey) {
    await storage.remove(previousKey).catch(() => {});
  }

  const [x0, y0, x1, y1] = updated.bbox ?? [0, 0, 0, 0];
  return Response.json({
    surfaceId,
    changed,
    source: updated.source,
    maskUrl: `/api/files/${maskKey}`,
    bbox: updated.bbox,
    anchor: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    confidence: null,
    areaM2:
      updated.areaM2Low != null && updated.areaM2High != null
        ? { low: updated.areaM2Low, high: updated.areaM2High, approximate: true as const }
        : null,
    coverage: stats.coverage,
  });
}
