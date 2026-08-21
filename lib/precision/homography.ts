/**
 * Planar homography — the arithmetic that makes "600×900 tiles" a measurement
 * rather than a decoration.
 *
 * THIS FILE HAS NO IMPORTS, and must not acquire any. Same rule as
 * `lib/editor/brush.ts` and for the same reason: the WebGL preview in the browser
 * and the full-resolution server render must agree to the pixel, and the only way
 * to guarantee that is for both to run this exact code. A preview that tiles
 * differently from the render makes the drag-the-quad interaction a lie.
 *
 * WHY A USER-DRAGGED QUAD AND NOT A DEPTH MODEL. Absolute metric scale cannot be
 * recovered from a single photo. Depth nets, vanishing points, and layout
 * estimators all give you orientation with the scale left unitless — fine for
 * compositing, useless for "these are 600mm tiles". Four corners plus one real
 * measurement ("this counter run is 2400mm") pins it exactly, needs no EXIF, and
 * is focal-length independent. The user knows one dimension of their own kitchen;
 * that is cheaper to ask for than it is to guess wrong.
 *
 * Everything here is a plain 9-number row-major array rather than a matrix class,
 * because the shader takes a `mat3` uniform and the warp loop wants raw numbers in
 * cache. A wrapper type would be nicer to read and slower everywhere it matters.
 */

/** Row-major 3x3. `[0..2]` is the first ROW. */
export type Mat3 = number[];
export type Vec2 = readonly [number, number];
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/* ------------------------------------------------------------------ solving */

/**
 * Gaussian elimination with partial pivoting, in place.
 *
 * Partial pivoting is not optional even for a well-posed 8x8: an axis-aligned
 * quad produces exact zeros on the diagonal, and without a row swap the very
 * first division is by zero. Axis-aligned is the DEFAULT case here — the auto-seed
 * hands back a quad from the mask's bounding box.
 */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    // Not "=== 0": a near-singular system means the four points are collinear or
    // coincident, which is a degenerate quad, and returning a garbage H would show
    // the user tiles smeared to infinity rather than an error they can act on.
    if (best < 1e-12) return null;
    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const d = A[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Hartley normalization: translate the centroid to the origin and scale so the
 * mean distance from it is sqrt(2).
 *
 * SKIPPING THIS IS THE CLASSIC HOMOGRAPHY BUG, and it does not announce itself.
 * The DLT rows mix terms of order x*u (about 1e6 for a 1000px image against
 * 3000mm of world) with terms of order 1, so the condition number runs to ~1e10
 * and the solve loses most of its significant digits — on the far-field rows
 * first, because that is where `w` is smallest. The symptom is tiles that look
 * right underfoot and visibly bow toward the vanishing point, which reads as "the
 * perspective is a bit off" rather than as an arithmetic failure. Normalized, the
 * same system conditions to ~1e2.
 */
function normalizer(pts: readonly Vec2[]): { T: Mat3; out: Vec2[] } {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;

  let mean = 0;
  for (const [x, y] of pts) mean += Math.hypot(x - cx, y - cy);
  mean /= pts.length;
  // All four points coincident. Degenerate, but must not produce Infinity — the
  // caller checks for null, and a NaN H would propagate into the shader silently.
  const s = mean < 1e-12 ? 1 : Math.SQRT2 / mean;

  return {
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    out: pts.map(([x, y]) => [s * (x - cx), s * (y - cy)] as Vec2),
  };
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Adjugate-based inverse. 3x3 is small enough that the closed form beats a solve. */
export function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/** Apply a homography to a point. Returns null when the point maps to the horizon. */
export function apply(m: Mat3, p: Vec2): Vec2 | null {
  const w = m[6] * p[0] + m[7] * p[1] + m[8];
  // A point ON the horizon line has no finite image. This is reachable in normal
  // use — a floor quad extended upward crosses its own vanishing line — so it is a
  // return value, not an exception.
  if (Math.abs(w) < 1e-12) return null;
  return [(m[0] * p[0] + m[1] * p[1] + m[2]) / w, (m[3] * p[0] + m[4] * p[1] + m[5]) / w];
}

/**
 * The 4-point DLT.
 *
 * With exactly 4 correspondences the system is 8 equations in 8 unknowns (h22 is
 * fixed to 1), so this is a plain linear solve — no SVD, no null-space extraction.
 * Fixing h22 = 1 is safe here because the world quad is a rectangle with a corner
 * at the origin, which can never map to the line at infinity.
 */
function dlt(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k];
    const [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Solve image px -> world mm from 4 corner correspondences, normalized.
 *
 * The returned H satisfies `apply(H, quad[k]) ~= world[k]` for all four, which
 * `verify()` below asserts rather than trusts.
 */
export function homographyFromQuad(
  quad: Quad,
  world: readonly [Vec2, Vec2, Vec2, Vec2],
): Mat3 | null {
  const a = normalizer(quad);
  const b = normalizer(world);
  const Hn = dlt(a.out, b.out);
  if (!Hn) return null;
  // Undo both normalizations: H = Tb^-1 * Hn * Ta.
  const TbInv = invert(b.T);
  if (!TbInv) return null;
  const H = matMul(TbInv, matMul(Hn, a.T));
  for (const v of H) if (!Number.isFinite(v)) return null;
  return H;
}

/**
 * Image quad -> a `refWidthMm` x `refHeightMm` rectangle, corners clockwise from
 * top-left. World origin at the quad's first corner, +x right, +y "away".
 */
export function planeFromQuad(
  quad: Quad,
  refWidthMm: number,
  refHeightMm: number,
): { H: Mat3; Hinv: Mat3 } | null {
  if (!(refWidthMm > 0) || !(refHeightMm > 0)) return null;
  const world: [Vec2, Vec2, Vec2, Vec2] = [
    [0, 0],
    [refWidthMm, 0],
    [refWidthMm, refHeightMm],
    [0, refHeightMm],
  ];
  const H = homographyFromQuad(quad, world);
  if (!H) return null;
  const Hinv = invert(H);
  if (!Hinv) return null;
  return { H, Hinv };
}

/**
 * Round-trip residual in px, worst corner.
 *
 * This is the "measurement check" the plan calls a trust feature: push each world
 * corner back through H^-1 and see how far from the user's own handle it lands. It
 * catches a transposed matrix, a swapped corner order, and a lost normalization —
 * all of which produce a plausible-looking H that is wrong.
 */
export function verify(H: Mat3, quad: Quad, refWidthMm: number, refHeightMm: number): number {
  const Hinv = invert(H);
  if (!Hinv) return Infinity;
  const world: Vec2[] = [
    [0, 0],
    [refWidthMm, 0],
    [refWidthMm, refHeightMm],
    [0, refHeightMm],
  ];
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const back = apply(Hinv, world[k]);
    if (!back) return Infinity;
    worst = Math.max(worst, Math.hypot(back[0] - quad[k][0], back[1] - quad[k][1]));
  }
  return worst;
}

/* --------------------------------------------------------------- footprint */

/**
 * How much texture one output pixel covers, from the ANALYTIC Jacobian.
 *
 * This is what separates a real projection from a toy one. Near the vanishing
 * point a single screen pixel spans a large and strongly ELONGATED patch of
 * texture; sampling it with 4 bilinear taps reads 4 texels out of hundreds, and
 * grout lines dissolve into grey shimmer that crawls when anything moves. To pick
 * the right mip level and the right number of taps you need the two singular
 * values of the local derivative — not just a scalar scale.
 *
 * A homography's derivative is closed-form, so finite differences would be both
 * slower and less accurate. With w = h20*x + h21*y + h22 and (u,v) the mapped
 * point, the quotient rule gives:
 *
 *     du/dx = (h00 - u*h20)/w      du/dy = (h01 - u*h21)/w
 *     dv/dx = (h10 - v*h20)/w      dv/dy = (h11 - v*h21)/w
 *
 * Returned as the major/minor axis lengths of the footprint ellipse, via the exact
 * singular values of the 2x2 Jacobian.
 */
export function footprint(
  H: Mat3,
  x: number,
  y: number,
): { major: number; minor: number } | null {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return null;
  const u = (H[0] * x + H[1] * y + H[2]) / w;
  const v = (H[3] * x + H[4] * y + H[5]) / w;

  const dudx = (H[0] - u * H[6]) / w;
  const dudy = (H[1] - u * H[7]) / w;
  const dvdx = (H[3] - v * H[6]) / w;
  const dvdy = (H[4] - v * H[7]) / w;

  // Singular values of [[dudx,dudy],[dvdx,dvdy]] in closed form. Using the row
  // norms instead (the common shortcut, and what the plan's `rho = max(...)`
  // sketches) OVERSTATES the minor axis whenever the rows are near-parallel, which
  // is exactly the grazing-angle case — so the renderer would blur along the short
  // axis it should have kept sharp. The extra dozen flops buy the sharpness.
  const a = dudx * dudx + dvdx * dvdx;
  const b = dudx * dudy + dvdx * dvdy;
  const c = dudy * dudy + dvdy * dvdy;
  const tr = a + c;
  const disc = Math.sqrt(Math.max(0, (a - c) * (a - c) + 4 * b * b));
  const major = Math.sqrt(Math.max(0, (tr + disc) / 2));
  const minor = Math.sqrt(Math.max(0, (tr - disc) / 2));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/**
 * Auto-seed a quad from a mask bbox, so the user drags rather than places.
 *
 * Trapezoidal rather than rectangular: for a floor seen from standing height the
 * far edge is always narrower, and starting from a rectangle means the user must
 * move all four handles instead of adjusting two. Inset from the bbox because mask
 * edges are ragged and a handle exactly on the boundary is hard to grab.
 */
export function seedQuad(
  bbox: readonly [number, number, number, number],
  width: number,
  height: number,
  narrowFar = 0.18,
): Quad {
  const [x0, y0, x1, y1] = bbox;
  const px0 = x0 * width;
  const px1 = x1 * width;
  const py0 = y0 * height;
  const py1 = y1 * height;
  const inset = (px1 - px0) * 0.06;
  const cx = (px0 + px1) / 2;
  const farHalf = ((px1 - px0) / 2 - inset) * (1 - narrowFar);
  return [
    [cx - farHalf, py0 + (py1 - py0) * 0.06],
    [cx + farHalf, py0 + (py1 - py0) * 0.06],
    [px1 - inset, py1 - (py1 - py0) * 0.02],
    [px0 + inset, py1 - (py1 - py0) * 0.02],
  ];
}

/**
 * Is the quad convex and non-degenerate?
 *
 * A self-intersecting quad (the user crossed two handles) still yields a solvable
 * H, and it maps the interior to a bow-tie — the render comes back with a fold in
 * it. Cross products of consecutive edges must all share a sign.
 */
export function isConvex(quad: Quad): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = quad[k];
    const [bx, by] = quad[(k + 1) % 4];
    const [cx, cy] = quad[(k + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
