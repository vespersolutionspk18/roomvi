/**
 * GET /api/images/[id]/surfaces — the detected zones, for the editor overlay.
 *
 * Returns mask URLs, not mask bytes. Each mask is a PNG the browser fetches
 * through /api/files and caches immutably, so the zone overlay is seven cheap
 * cached image loads rather than a megabyte of base64 in a JSON body that can
 * never be cached.
 *
 * Ordered largest-first so the overlay stacks sensibly: walls and floor beneath,
 * small details on top, which is also the order a click should resolve.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { images, surfaces } from "@/lib/db/schema";
import { tintFor } from "@/lib/analyze";
import { PLANAR_KINDS } from "@/lib/render/precision";
import type { SegmentableKind } from "@/lib/segment";

export async function GET(_request: Request, ctx: RouteContext<"/api/images/[id]/surfaces">) {
  const { id } = await ctx.params;

  const image = await db.query.images.findFirst({ where: eq(images.id, id) });
  if (!image) {
    return Response.json(
      { error: { code: "not_found", message: "Image not found." } },
      { status: 404 },
    );
  }

  const rows = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, id) });

  // The plane's quad is stored in DISPLAY PX, because that is the space the mask and
  // the warp work in. It goes out NORMALIZED, because that is the space everything
  // the user points at travels in — masks, brush strokes, bboxes, chip anchors. Two
  // conventions, one converted at each boundary, rather than a mix on the wire.
  const dw = image.displayWidth ?? 0;
  const dh = image.displayHeight ?? 0;
  const norm = dw > 0 && dh > 0;

  const zones = rows
    .map((s) => {
      const [x0, y0, x1, y1] = s.bbox ?? [0, 0, 0, 0];
      return {
        id: s.id,
        kind: s.kind,
        label: s.label,
        source: s.source,
        confidence: s.confidence,
        /** Fetched and cached by the browser; never inlined. */
        maskUrl: `/api/files/${s.maskKey}`,
        bbox: s.bbox,
        /** Chip anchor: bbox centre, normalized. The mockup's `.hotspot` position. */
        anchor: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
        /** Overlay tint, so client and server agree on a surface's colour. */
        tint: tintFor(s.kind as SegmentableKind),
        /**
         * A RANGE, never a point value. Single-photo area is ±15-25%, so the
         * mockup's "18.4 m² · 98% confidence" is a claim the geometry cannot
         * support. Precision mode's plane fit is what makes a real number
         * possible, and even then only because the user names a true distance.
         */
        areaM2: s.areaM2Low != null && s.areaM2High != null
          ? { low: s.areaM2Low, high: s.areaM2High, approximate: true }
          : null,
        hasPlane: s.plane != null,
        /**
         * The measured plane, or null.
         *
         * The QUAD is the payload that matters: it is what the user dragged, and
         * the editor must be able to put the handles back where they left them —
         * a plane you cannot see or adjust is one the user has to redo blind.
         *
         * `H` rides along so the WebGL preview does not have to re-solve before it
         * can draw. It is derived from the quad by the same zero-import module the
         * client runs, so this is a cache rather than a second source of truth, and
         * the client is free to re-solve while a handle is in motion.
         */
        plane:
          s.plane && norm
            ? {
                quad: s.plane.quad.map(([x, y]) => [x / dw, y / dh]) as [
                  [number, number],
                  [number, number],
                  [number, number],
                  [number, number],
                ],
                refWidthMm: s.plane.refWidthMm,
                refHeightMm: s.plane.refHeightMm,
                /**
                 * H stays in PX, unlike the quad.
                 *
                 * It is a px -> mm map, so normalizing it would need the display
                 * dimensions folded into the matrix, and the client would then have
                 * to un-fold them before handing it to the shader. Sending it raw
                 * keeps `homographyFromQuad`'s output and this field the same
                 * object, which is the whole reason that module has no imports.
                 */
                H: s.plane.H,
                thetaDeg: (s.plane.theta * 180) / Math.PI,
              }
            : null,
        /**
         * Can Precision render here at all, before a material is even chosen?
         *
         * Only the surface half of `eligible()` — the material half is decided in
         * the sidebar, where `precisionReady` already answers it per swatch. Split
         * that way so the editor can grey out a whole surface with one reason
         * rather than repeating it against fifteen swatches.
         */
        planar: PLANAR_KINDS.has(s.kind),
      };
    })
    // Largest zone first, by bbox area.
    .sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));

  return Response.json({
    imageId: id,
    /** The owning project — the editor needs it to attribute reference uploads. */
    projectId: image.projectId,
    analyzedAt: image.analyzedAt,
    /** Masks live in DISPLAY pixel space — the client needs these to map them. */
    width: image.displayWidth,
    height: image.displayHeight,
    imageUrl: image.displayKey ? `/api/files/${image.displayKey}` : null,
    zones,
  });
}

function bboxArea(b: [number, number, number, number] | null): number {
  if (!b) return 0;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}
