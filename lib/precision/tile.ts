/**
 * The tiler: world millimetres -> a texel coordinate and a grout mask.
 *
 * NO IMPORTS, same contract as `homography.ts` — the fragment shader is a
 * transliteration of these functions and the two must not drift.
 *
 * Everything here happens in mm. That is the whole point: the pipeline is
 * image px -> (H) -> mm -> (this) -> texel, so tile size, grout width and bond
 * offset are all stated in the units the supplier quotes, and the projection
 * decides how big that looks on screen. Working in a normalized texture space
 * instead would mean scale is a fudge factor tuned per photo, which is the thing
 * Precision mode exists not to do.
 */

export type Bond = "stack" | "running" | "herringbone";

export type TileSpec = {
  /** Tile FACE size in mm, grout excluded. */
  tileWMm: number;
  tileHMm: number;
  groutMm: number;
  bond: Bond;
  /** Course rotation in radians, applied about the world origin. */
  theta: number;
};

export type TileSample = {
  /** Position within the tile face, both in [0,1). */
  u: number;
  v: number;
  /** 0 inside the face, ramping to 1 at the centre of the grout joint. */
  grout: number;
  /** Stable per-tile index — drives variant selection and per-tile jitter. */
  row: number;
  col: number;
};

/** FNV-1a over two ints. Deterministic across runtimes, which `Math.random` is not. */
export function tileHash(row: number, col: number): number {
  let h = 0x811c9dc5;
  h = (h ^ (row & 0xffff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((row >> 16) & 0xffff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ (col & 0xffff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((col >> 16) & 0xffff)) >>> 0;
  h = Math.imul(h, 0x01000193) >>> 0;
  return h >>> 0;
}

/** Hash to [0,1). */
const unit = (h: number) => h / 4294967296;

/**
 * Map a world-mm point to a tile-local coordinate.
 *
 * `grout` is returned as a RAMP rather than a boolean because the joint is
 * typically 3mm and, at the far end of a floor, 3mm is a fraction of a pixel — a
 * hard test there aliases into a dotted line that crawls. The ramp lets the caller
 * blend proportionally, which is what an area-average would have produced anyway.
 * `groutSoftMm` should be about the footprint width in mm, so the joint softens
 * exactly as fast as it shrinks.
 */
export function sampleTile(
  xMm: number,
  yMm: number,
  spec: TileSpec,
  groutSoftMm = 0,
): TileSample {
  // Rotate first: the courses run along the wall, not along the world axes. Snapped
  // by the caller to the dominant direction, because a floor 2 degrees off looks
  // like a mistake where 0 or 45 looks like a decision.
  const cos = Math.cos(-spec.theta);
  const sin = Math.sin(-spec.theta);
  const rx = xMm * cos - yMm * sin;
  const ry = xMm * sin + yMm * cos;

  const cellW = spec.tileWMm + spec.groutMm;
  const cellH = spec.tileHMm + spec.groutMm;

  if (spec.bond === "herringbone") return herringbone(rx, ry, spec, groutSoftMm);

  const row = Math.floor(ry / cellH);
  // Running bond offsets alternate courses by half a tile. Offsetting the
  // COORDINATE rather than the cell index is what keeps the pattern continuous
  // across the origin — offsetting the index leaves a visible discontinuity there.
  const shift = spec.bond === "running" ? ((row % 2) + 2) % 2 * cellW * 0.5 : 0;
  const sx = rx + shift;
  const col = Math.floor(sx / cellW);

  const inCellX = sx - col * cellW;
  const inCellY = ry - row * cellH;

  return {
    ...faceCoord(inCellX, inCellY, spec, cellW, cellH, groutSoftMm),
    row,
    col,
  };
}

/**
 * Fraction of a box filter of half-width `soft` covered by a joint of half-width
 * `half`, at distance `dc` from the joint's CENTRELINE.
 *
 * This is the honest area-average, and it replaces a `1 - d/soft` ramp that got two
 * limits wrong. The ramp reached 1 at the cell boundary regardless of the joint's
 * real width, so:
 *
 *   groutMm = 0   -> still painted grout, over a band as wide as the footprint. A
 *                    zero-width joint has nothing to anti-alias; it must vanish.
 *   far field     -> a 5mm joint under a 26mm footprint read as ~full grout across
 *                    that whole band instead of the 19% it physically covers, which
 *                    is why the far half of a small-format floor came out grout-
 *                    coloured rather than tile-coloured.
 *
 * Both limits now fall out of the geometry: as `soft` goes to zero this is a hard
 * inside/outside test, and as `soft` grows it decays as groutMm/(2*soft).
 */
function stripeCoverage(dc: number, half: number, soft: number): number {
  const lo = Math.max(dc - soft, -half);
  const hi = Math.min(dc + soft, half);
  return hi <= lo ? 0 : (hi - lo) / (2 * soft);
}

/**
 * Position within one cell -> face uv + grout coverage.
 *
 * The joint is split half onto each side of the cell boundary, so a 3mm grout
 * between two 600mm tiles puts 1.5mm at each edge and the pitch stays 603mm. The
 * naive version (full grout on one edge only) shifts every tile by half a joint and
 * the measurement check catches it as a 1.5mm error that accumulates across the
 * room.
 */
function faceCoord(
  inCellX: number,
  inCellY: number,
  spec: TileSpec,
  cellW: number,
  cellH: number,
  groutSoftMm: number,
): { u: number; v: number; grout: number } {
  const half = spec.groutMm / 2;
  const soft = Math.max(groutSoftMm, 1e-6);

  // Distance to the nearest joint CENTRELINE on each axis. The centrelines sit at
  // inCell 0 and inCell cell, because the joint straddles the cell boundary.
  const cx = stripeCoverage(Math.min(inCellX, cellW - inCellX), half, soft);
  const cy = stripeCoverage(Math.min(inCellY, cellH - inCellY), half, soft);

  // Union of the two stripes, treating them as independent. At a corner both cover
  // the footprint, and `cx + cy` alone would exceed 1 there and clip to a visibly
  // fatter blob at every tile intersection.
  const grout = cx + cy - cx * cy;

  const u = (inCellX - half) / spec.tileWMm;
  const v = (inCellY - half) / spec.tileHMm;
  return { u: u - Math.floor(u), v: v - Math.floor(v), grout };
}

/**
 * Herringbone: pairs of tiles at +/-45 degrees.
 *
 * Worth the special case because it is the pattern people pay a tiler extra for,
 * and faking it by rotating the texture 45 degrees is visibly wrong — the tiles
 * must interlock, not overlap. Solved in the units of the SHORT side, where the
 * layout is a simple 2x2 block of L-shaped pairs.
 */
function herringbone(
  x: number,
  y: number,
  spec: TileSpec,
  groutSoftMm: number,
): TileSample {
  const s = Math.min(spec.tileWMm, spec.tileHMm) + spec.groutMm;
  const long = Math.max(spec.tileWMm, spec.tileHMm) + spec.groutMm;
  // Assumes a 2:1 tile, which is what herringbone is laid with. A non-2:1 tile
  // still tiles here, just with the ratio honoured on the long axis.
  const period = long + s;

  const bx = Math.floor(x / period);
  const by = Math.floor(y / period);
  const fx = x - bx * period;
  const fy = y - by * period;

  // Two L-oriented tiles per block: one horizontal in the lower-left, one vertical
  // in the upper-right.
  const horizontal = fy < s;
  const inCellX = horizontal ? fx : fy - s;
  const inCellY = horizontal ? fy : period - fx;
  const cellW = horizontal ? long : long;
  const cellH = s;

  const face = faceCoord(
    Math.min(inCellX, cellW - 1e-6),
    Math.min(Math.max(inCellY, 0), cellH - 1e-6),
    { ...spec, tileWMm: cellW - spec.groutMm, tileHMm: cellH - spec.groutMm },
    cellW,
    cellH,
    groutSoftMm,
  );
  return { ...face, row: by * 2 + (horizontal ? 0 : 1), col: bx };
}

/**
 * Per-tile variation: rotation quadrant, mirror, and sub-mm offset.
 *
 * Perfect repetition is THE tell. A real floor has tiles from the same batch with
 * different grain, laid by a human who did not align them to a micron. Four
 * quadrant rotations plus a mirror gives 8 apparent variants from one bitmap for
 * free, and the sub-mm jitter breaks the lattice regularity the eye picks up even
 * when it cannot see individual tiles.
 */
export function tileVariant(
  row: number,
  col: number,
  u: number,
  v: number,
  jitterMm = 0.6,
  tileWMm = 600,
  tileHMm = 600,
): { u: number; v: number } {
  const h = tileHash(row, col);
  const quadrant = h & 3;
  const mirror = (h >> 2) & 1;

  let a = u;
  let b = v;
  if (mirror) a = 1 - a;
  for (let k = 0; k < quadrant; k++) {
    const t = a;
    a = 1 - b;
    b = t;
  }
  // Jitter in mm, converted to uv, so a 0.6mm nudge is 0.6mm on a 600 tile and on
  // a 100 tile — jittering in uv would make small tiles wobble 6x as much.
  a += (unit(tileHash(row, col + 7919)) - 0.5) * 2 * (jitterMm / tileWMm);
  b += (unit(tileHash(row + 7919, col)) - 0.5) * 2 * (jitterMm / tileHMm);
  return { u: a - Math.floor(a), v: b - Math.floor(b) };
}

/**
 * Snap a course angle to the nearest sensible one.
 *
 * A tiler lays parallel to the longest wall or at 45 degrees to it, never at 7
 * degrees. Snapping within a tolerance means the auto-derived angle lands on the
 * intended one instead of betraying itself as an estimate.
 */
export function snapTheta(theta: number, toleranceRad = 0.14): number {
  const step = Math.PI / 4;
  const nearest = Math.round(theta / step) * step;
  return Math.abs(theta - nearest) <= toleranceRad ? nearest : theta;
}
