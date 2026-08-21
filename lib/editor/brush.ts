/**
 * Brush geometry — the rasterizer, shared verbatim by the browser and the server.
 *
 * THIS FILE HAS NO IMPORTS, and must not acquire any. That is the whole design.
 *
 * A brush that previews one thing and saves another is worse than no brush: the
 * user corrects a mask, sees the correction, saves, and the render comes back
 * wrong in a way they cannot see or explain. The only way to rule that out is for
 * both sides to run the SAME function over the same bits, so `lib/render/prompt.ts`
 * sets the precedent and this follows it. The canvas the user paints on is not an
 * approximation of what will be stored; applying these strokes to the decoded
 * mask is a pure function, and both sides call it.
 *
 * Coordinates are NORMALIZED, never pixels. The client paints on a CSS box of
 * whatever size the window happens to be, the mask lives in display pixel space,
 * and the two are only equal by accident. Radius is normalized to the SHORT edge
 * so a 24px brush stays a 24px brush when the window is resized mid-stroke.
 */

export type BrushMode = "add" | "subtract";

export type Point = { x: number; y: number };

export type Stroke = {
  mode: BrushMode;
  /** Radius as a fraction of the image's SHORT edge. */
  radius: number;
  /** Normalized points in the order they were drawn. */
  points: Point[];
};

/**
 * Limits, exported so the route and the UI enforce the same ones.
 *
 * These bound the work, not the user's intent: 4000 points at 60Hz is over a
 * minute of continuous drawing, and the client thins points anyway. A stroke
 * arriving over these is a bug or an attack, and in both cases the answer is 400.
 */
export const MAX_STROKES = 400;
export const MAX_POINTS_PER_STROKE = 4000;
export const MIN_RADIUS = 0.004;
export const MAX_RADIUS = 0.2;

/** The default, ≈24px on a 768px-tall display copy. */
export const DEFAULT_RADIUS = 0.03;

/**
 * Paint every stroke onto `bits`, in place, in the order given.
 *
 * Temporal order is the only correct order — "add, then rub some of it out" and
 * "rub out, then add" produce different masks, and the user watched one of them
 * happen. Grouping adds before subtracts would be faster and wrong.
 *
 * Returns how many pixels actually changed value, which is what lets a caller
 * reject a save that would be a no-op (or one that erased everything).
 */
export function applyStrokes(
  bits: Uint8Array,
  width: number,
  height: number,
  strokes: readonly Stroke[],
): number {
  let changed = 0;
  const short = Math.min(width, height);

  for (const stroke of strokes) {
    const on = stroke.mode === "add" ? 255 : 0;
    // At least half a pixel: a radius that rounds to zero would silently no-op,
    // and a user dragging a hairline brush deserves a hairline, not nothing.
    const r = Math.max(0.5, stroke.radius * short);
    const r2 = r * r;
    const pts = stroke.points;
    if (pts.length === 0) continue;

    for (let s = 0; s < Math.max(1, pts.length - 1); s++) {
      const a = pts[s];
      // A tap is a one-point stroke, so the segment degenerates to a disc. Falling
      // out of that naturally is why this is a capsule fill and not a disc-stamp
      // walk — no spacing constant to tune, no beading on fast strokes.
      const b = pts[s + 1] ?? a;

      const ax = a.x * width;
      const ay = a.y * height;
      const bx = b.x * width;
      const by = b.y * height;

      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));

      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;

      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        // Pixel CENTRES, so a disc of radius 0.5 on a pixel centre covers exactly
        // that pixel. Using the corner shifts every stroke half a pixel up-left,
        // which is invisible on a brush and very visible on the mask edge.
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          let d2: number;
          if (len2 === 0) {
            const ex = px - ax;
            const ey = py - ay;
            d2 = ex * ex + ey * ey;
          } else {
            let t = ((px - ax) * dx + (py - ay) * dy) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ex = px - (ax + t * dx);
            const ey = py - (ay + t * dy);
            d2 = ex * ex + ey * ey;
          }
          if (d2 > r2) continue;
          const i = row + x;
          if (bits[i] !== on) {
            bits[i] = on;
            changed++;
          }
        }
      }
    }
  }

  return changed;
}

/**
 * Structural validation, run on both sides.
 *
 * The client uses this to avoid posting a payload it knows will be refused; the
 * route uses it because a client is not a source of truth. Returns a reason
 * rather than throwing, so the route can put it in the error body verbatim.
 */
export function validateStrokes(value: unknown): { ok: true; strokes: Stroke[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "strokes must be an array" };
  if (value.length === 0) return { ok: false, reason: "no strokes" };
  if (value.length > MAX_STROKES) return { ok: false, reason: `more than ${MAX_STROKES} strokes` };

  const out: Stroke[] = [];
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: `stroke ${i}: not an object` };
    const s = raw as Record<string, unknown>;

    if (s.mode !== "add" && s.mode !== "subtract") {
      return { ok: false, reason: `stroke ${i}: mode must be add or subtract` };
    }
    if (typeof s.radius !== "number" || !Number.isFinite(s.radius)) {
      return { ok: false, reason: `stroke ${i}: radius must be a number` };
    }
    if (s.radius < MIN_RADIUS || s.radius > MAX_RADIUS) {
      return { ok: false, reason: `stroke ${i}: radius out of range` };
    }
    if (!Array.isArray(s.points) || s.points.length === 0) {
      return { ok: false, reason: `stroke ${i}: no points` };
    }
    if (s.points.length > MAX_POINTS_PER_STROKE) {
      return { ok: false, reason: `stroke ${i}: more than ${MAX_POINTS_PER_STROKE} points` };
    }

    const points: Point[] = [];
    for (const p of s.points) {
      if (typeof p !== "object" || p === null) return { ok: false, reason: `stroke ${i}: bad point` };
      const { x, y } = p as Record<string, unknown>;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: `stroke ${i}: point is not finite` };
      }
      // Clamped rather than rejected: a stroke that runs off the edge of the photo
      // is a completely normal thing to draw, and the rasterizer clips anyway.
      points.push({ x: clamp01(x), y: clamp01(y) });
    }

    out.push({ mode: s.mode, radius: s.radius, points });
  }
  return { ok: true, strokes: out };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Drop points that add nothing.
 *
 * A pointer event stream at 120Hz sends dozens of points inside one brush width,
 * and each one costs a full capsule fill over an overlapping bbox. Keeping points
 * at least a third of a radius apart is visually identical and cuts the work by
 * an order of magnitude on a slow drag — which matters because this runs on the
 * UI thread between frames.
 */
export function thin(points: readonly Point[], radius: number, aspect: number): Point[] {
  if (points.length < 3) return [...points];
  const minStep = radius / 3;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    // Normalized space is anisotropic when the image is not square, so compare in
    // short-edge units or a wide photo thins horizontally more than vertically.
    const dx = (points[i].x - last.x) * aspect;
    const dy = points[i].y - last.y;
    if (Math.hypot(dx, dy) >= minStep) out.push(points[i]);
  }
  // The final point always survives: it is where the user let go, and dropping it
  // shortens every stroke by up to a third of a radius.
  out.push(points[points.length - 1]);
  return out;
}
