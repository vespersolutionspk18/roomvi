/**
 * Paint-mask rasterization. Client-side, zero imports.
 *
 * The strokes the user drew are normalized geometry; this turns them into the
 * PNG the render pipeline consumes: black canvas, white where the change may
 * land, at the photo's DISPLAY dimensions so it composites 1:1 server-side.
 *
 * Circles stamped along interpolated paths rather than stroked lines: a line
 * join has no opinion about "erase over paint", while stamping makes add and
 * erase literally the same operation in different colours — undo order falls
 * out of stroke order for free.
 */
import type { PaintStroke } from "./types";

/** Long enough that a fast flick never leaves gaps between stamps. */
const STAMP_SPACING_PX = 2;

function stampPath(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  radiusPx: number,
  colour: string,
) {
  ctx.fillStyle = colour;
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, radiusPx, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / STAMP_SPACING_PX));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.beginPath();
      ctx.arc(x, y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Render the strokes to a canvas context, in NORMALIZED coordinates scaled by
 * `width`/`height`. Shared by the exporter and the live overlay so what the
 * user saw is exactly what ships.
 */
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: PaintStroke[],
  width: number,
  height: number,
) {
  const shortEdge = Math.min(width, height);
  for (const stroke of strokes) {
    stampPath(
      ctx,
      stroke.points.map((p) => ({ x: p.x * width, y: p.y * height })),
      stroke.radius * shortEdge,
      stroke.mode === "add" ? "#ffffff" : "#000000",
    );
  }
}

/** The mask PNG, ready to upload. */
export async function rasterizePaintMask(
  strokes: PaintStroke[],
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  drawStrokes(ctx, strokes, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode the painted mask."));
    }, "image/png");
  });
}
