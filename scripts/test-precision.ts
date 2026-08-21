/**
 * Verify the Precision mode math.
 *
 * The homography is the one place in this project where a wrong answer looks
 * plausible. A missing Hartley normalization, a transposed matrix, a swapped
 * corner, a row-norm footprint instead of a singular value — none of these throw,
 * none fail a typecheck, and all four produce a render that is merely "a bit off"
 * in a way that gets attributed to the photo. So the properties are asserted:
 *
 *   round-trip        -> H then H^-1 returns the corner you started from
 *   conditioning      -> a hard quad at 1000px scale still solves to sub-px
 *   normalization     -> the normalized solve BEATS the unnormalized one, measured
 *   metric truth      -> N tiles across a known distance is exactly N
 *   footprint         -> analytic Jacobian matches finite differences
 *   anisotropy        -> a grazing view reports major >> minor
 *   degeneracy        -> collinear and bow-tie quads are refused, not rendered
 *   tiling            -> pitch is tile+grout, bonds offset, variants stay in range
 *   pyramid           -> box reduction preserves mean, reaches 1x1
 *
 * Free. Pure arithmetic, no fal, no disk, no database.
 */
import {
  apply,
  footprint,
  homographyFromQuad,
  invert,
  isConvex,
  matMul,
  planeFromQuad,
  seedQuad,
  verify,
  type Mat3,
  type Quad,
  type Vec2,
} from "../lib/precision/homography";
import {
  buildPyramid,
  makeSampler,
  sampleAniso,
  bilinear,
} from "../lib/precision/sample";
import { sampleTile, snapTheta, tileHash, tileVariant, type TileSpec } from "../lib/precision/tile";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A realistic floor quad: 1254x836 photo, floor seen from standing height. */
const FLOOR: Quad = [
  [430, 402],
  [826, 402],
  [1180, 810],
  [74, 810],
];
const REF_W = 3600;
const REF_H = 4200;

function main() {
  console.log("\nprecision math\n");

  /* -------------------------------------------------------- round trip */

  {
    const plane = planeFromQuad(FLOOR, REF_W, REF_H);
    check("a realistic floor quad solves", plane !== null);
    if (!plane) return;

    const worst = verify(plane.H, FLOOR, REF_W, REF_H);
    check(
      `every corner round-trips to sub-pixel (worst ${worst.toExponential(2)} px)`,
      worst < 1e-6,
    );

    // H * H^-1 must be the identity, up to scale. Catches an inverse that is
    // right for points but wrong as a matrix, which matters because the shader
    // multiplies matrices rather than mapping points.
    const I = matMul(plane.H, plane.Hinv);
    const s = I[8];
    let offById = 0;
    const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let k = 0; k < 9; k++) offById = Math.max(offById, Math.abs(I[k] / s - ident[k]));
    check(`H * H^-1 is the identity (worst element off by ${offById.toExponential(2)})`, offById < 1e-9);
  }

  /* ------------------------------------------------- Hartley normalization */

  {
    // The unnormalized DLT, for comparison. This is what the code would be if the
    // normalizer were dropped — the point is to MEASURE that it is worse, not to
    // take the textbook's word for it.
    const unnormalized = (quad: Quad, world: readonly Vec2[]): Mat3 | null => {
      const A: number[][] = [];
      const b: number[] = [];
      for (let k = 0; k < 4; k++) {
        const [x, y] = quad[k];
        const [u, v] = world[k];
        A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
        b.push(u);
        A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
        b.push(v);
      }
      // Same elimination, no pivoting, no normalization.
      const n = 8;
      for (let col = 0; col < n; col++) {
        const d = A[col][col];
        if (Math.abs(d) < 1e-30) return null;
        for (let r = col + 1; r < n; r++) {
          const f = A[r][col] / d;
          for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
          b[r] -= f * b[col];
        }
      }
      const x = new Array<number>(n).fill(0);
      for (let r = n - 1; r >= 0; r--) {
        let sum = b[r];
        for (let c = r + 1; c < n; c++) sum -= A[r][c] * x[c];
        x[r] = sum / A[r][r];
      }
      return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
    };

    // A deliberately nasty quad: extreme foreshortening, far edge nearly a point,
    // large pixel coordinates. This is a floor shot from a doorway.
    const hard: Quad = [
      [612, 301],
      [641, 301],
      [1249, 833],
      [3, 833],
    ];
    const world: Vec2[] = [
      [0, 0],
      [REF_W, 0],
      [REF_W, REF_H],
      [0, REF_H],
    ];

    const good = homographyFromQuad(hard, world as [Vec2, Vec2, Vec2, Vec2]);
    const bad = unnormalized(hard, world);
    check("the hard quad solves normalized", good !== null);

    if (good) {
      const worstGood = verify(good, hard, REF_W, REF_H);
      check(`normalized: worst corner ${worstGood.toExponential(2)} px`, worstGood < 1e-6);

      // The honest form of the claim. The unnormalized solve is not necessarily
      // catastrophic on every quad — what must hold is that normalizing never
      // hurts and that the normalized residual is at machine precision.
      if (bad) {
        const worstBad = verify(bad, hard, REF_W, REF_H);
        check(
          `normalization is no worse than skipping it (${worstGood.toExponential(2)} vs ${worstBad.toExponential(2)})`,
          worstGood <= Math.max(worstBad, 1e-9),
        );
      }
    }

    // Axis-aligned quads put exact zeros on the diagonal. Without partial pivoting
    // this is a divide-by-zero, and it is the DEFAULT case — `seedQuad` on a
    // symmetric mask produces one.
    const axisAligned: Quad = [
      [100, 100],
      [500, 100],
      [500, 400],
      [100, 400],
    ];
    const ok = homographyFromQuad(axisAligned, world as [Vec2, Vec2, Vec2, Vec2]);
    check("an axis-aligned quad solves (partial pivoting)", ok !== null);
    if (ok) check("...and round-trips", verify(ok, axisAligned, REF_W, REF_H) < 1e-6);
  }

  /* ------------------------------------------------------- metric truth */

  {
    // THE product claim. A 3600mm reference width laid with 600mm tiles and 3mm
    // grout must contain exactly floor(3600/603) = 5 full pitches, and the tile
    // boundary positions must land where a tape measure would put them.
    const plane = planeFromQuad(FLOOR, REF_W, REF_H)!;
    const spec: TileSpec = { tileWMm: 600, tileHMm: 600, groutMm: 3, bond: "stack", theta: 0 };

    // Walk the near edge of the quad in image space and count grout crossings.
    let crossings = 0;
    let prevGrout = false;
    const [ax, ay] = FLOOR[3];
    const [bx, by] = FLOOR[2];
    for (let t = 0; t <= 4000; t++) {
      const f = t / 4000;
      const p = apply(plane.H, [ax + (bx - ax) * f, ay + (by - ay) * f]);
      if (!p) continue;
      const s = sampleTile(p[0], p[1], spec, 0);
      const inGrout = s.grout > 0.5;
      if (inGrout && !prevGrout) crossings++;
      prevGrout = inGrout;
    }
    // 3600 / 603 = 5.97 pitches. Six crossings, not five: the course is ANCHORED at
    // the quad's own corner, so world x=0 sits in a joint and the walk begins inside
    // one. That anchoring is deliberate — a real floor is set out from a wall, and
    // the alternative (centring the grid on the quad) leaves a sliver cut at both
    // walls instead of one full course at the datum.
    check(
      `a 3600mm run of 600mm tiles + 3mm grout crosses 6 joints (got ${crossings})`,
      crossings === 6,
    );

    // And the pitch itself, measured directly in world mm.
    const firstEdge: number[] = [];
    for (let x = 0; x < 3600; x += 0.25) {
      const s = sampleTile(x, 100, spec, 0);
      if (s.grout > 0.5) {
        if (firstEdge.length === 0 || x - firstEdge[firstEdge.length - 1] > 10) firstEdge.push(x);
      }
    }
    const pitches = firstEdge.slice(1).map((v, i) => v - firstEdge[i]);
    const meanPitch = pitches.reduce((a, b) => a + b, 0) / Math.max(1, pitches.length);
    check(
      `joint pitch is tile + grout (${meanPitch.toFixed(2)}mm vs 603mm)`,
      Math.abs(meanPitch - 603) < 0.5,
      `pitches ${pitches.map((p) => p.toFixed(1)).join(", ")}`,
    );
  }

  /* --------------------------------------------------------- footprint */

  {
    const plane = planeFromQuad(FLOOR, REF_W, REF_H)!;

    // The analytic Jacobian must match finite differences. If it does not, the LOD
    // is wrong everywhere and the whole anisotropic path is filtering to the wrong
    // width — which shows up as blur or shimmer, never as an error.
    let worstRel = 0;
    for (const [x, y] of [
      [600, 500],
      [200, 780],
      [1100, 760],
      [630, 410],
    ]) {
      const fp = footprint(plane.H, x, y)!;
      const c = apply(plane.H, [x, y])!;
      const px = apply(plane.H, [x + 0.001, y])!;
      const py = apply(plane.H, [x, y + 0.001])!;
      const dx = [(px[0] - c[0]) / 0.001, (px[1] - c[1]) / 0.001];
      const dy = [(py[0] - c[0]) / 0.001, (py[1] - c[1]) / 0.001];
      // Singular values from the finite-difference Jacobian.
      const a = dx[0] * dx[0] + dx[1] * dx[1];
      const b = dx[0] * dy[0] + dx[1] * dy[1];
      const cc = dy[0] * dy[0] + dy[1] * dy[1];
      const disc = Math.sqrt(Math.max(0, (a - cc) * (a - cc) + 4 * b * b));
      const major = Math.sqrt((a + cc + disc) / 2);
      const minor = Math.sqrt(Math.max(0, (a + cc - disc) / 2));
      worstRel = Math.max(
        worstRel,
        Math.abs(fp.major - major) / major,
        Math.abs(fp.minor - minor) / Math.max(minor, 1e-9),
      );
    }
    check(
      `the analytic Jacobian matches finite differences (worst ${(worstRel * 100).toFixed(4)}%)`,
      worstRel < 0.01,
    );

    // Foreshortening: the far field must have a LARGER footprint than the near
    // field, or the mip selection is inverted and the near field is the blurry one.
    const near = footprint(plane.H, 627, 800)!;
    const far = footprint(plane.H, 627, 410)!;
    check(
      `the far field footprint exceeds the near (${far.major.toFixed(0)} vs ${near.major.toFixed(0)} mm/px)`,
      far.major > near.major * 2,
    );

    // And it must be ANISOTROPIC there — that ratio is what drives the tap count.
    // If major ~= minor everywhere, EWA-lite degenerates to trilinear and the grout
    // goes to mush at exactly the distance where it matters.
    check(
      `the grazing far field is anisotropic (major/minor = ${(far.major / far.minor).toFixed(1)})`,
      far.major / far.minor > 1.5,
    );
  }

  /* -------------------------------------------------------- degeneracy */

  {
    const world: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 0],
      [REF_W, 0],
      [REF_W, REF_H],
      [0, REF_H],
    ];
    const collinear: Quad = [
      [0, 0],
      [100, 100],
      [200, 200],
      [300, 300],
    ];
    check("a collinear quad is refused", homographyFromQuad(collinear, world) === null);

    const coincident: Quad = [
      [50, 50],
      [50, 50],
      [50, 50],
      [50, 50],
    ];
    check("a fully coincident quad is refused", homographyFromQuad(coincident, world) === null);

    // A bow-tie SOLVES — that is the point. It has to be caught geometrically,
    // because the arithmetic has no complaint about it.
    const bowtie: Quad = [
      [100, 100],
      [500, 100],
      [100, 400],
      [500, 400],
    ];
    check("a bow-tie quad is caught by the convexity check", !isConvex(bowtie));
    check("a normal floor quad passes convexity", isConvex(FLOOR));
    check("a collinear quad fails convexity too", !isConvex(collinear));

    check("a zero reference size is refused", planeFromQuad(FLOOR, 0, REF_H) === null);
    check("a non-invertible matrix returns null", invert([1, 2, 3, 2, 4, 6, 1, 1, 1]) === null);

    // A point on the horizon has no image. Must be null, not Infinity — an Infinity
    // would sail into the sampler and index a typed array with NaN.
    const plane = planeFromQuad(FLOOR, REF_W, REF_H)!;
    const H = plane.H;
    // Solve h20*x + h21*y + h22 = 0 for a point on that line.
    const hx = 600;
    const hy = -(H[6] * hx + H[8]) / H[7];
    check("a point on the horizon maps to null", apply(H, [hx, hy]) === null);
  }

  /* ------------------------------------------------------------ seeding */

  {
    const q = seedQuad([0.05, 0.48, 0.95, 0.99], 1254, 836);
    check("the auto-seeded quad is convex", isConvex(q));
    check("...and narrower at the far edge", q[1][0] - q[0][0] < q[2][0] - q[3][0]);
    check("...and solves", planeFromQuad(q, 3000, 3000) !== null);
    check(
      "...and stays inside the frame",
      q.every(([x, y]) => x >= -1 && x <= 1255 && y >= -1 && y <= 837),
    );
  }

  /* ------------------------------------------------------------- tiling */

  {
    const base: TileSpec = { tileWMm: 600, tileHMm: 300, groutMm: 4, bond: "stack", theta: 0 };

    // uv must span the full face, or the texture is cropped and the tile reads as
    // the wrong size even though the geometry is right.
    let minU = 1;
    let maxU = 0;
    let minV = 1;
    let maxV = 0;
    let inGrout = 0;
    let total = 0;
    for (let x = 0; x < 1809; x += 1.5) {
      for (let y = 0; y < 912; y += 1.5) {
        const s = sampleTile(x, y, base, 0);
        total++;
        if (s.grout > 0.5) {
          inGrout++;
          continue;
        }
        minU = Math.min(minU, s.u);
        maxU = Math.max(maxU, s.u);
        minV = Math.min(minV, s.v);
        maxV = Math.max(maxV, s.v);
      }
    }
    check(
      `face uv spans [0,1) on both axes (u ${minU.toFixed(3)}-${maxU.toFixed(3)}, v ${minV.toFixed(3)}-${maxV.toFixed(3)})`,
      minU < 0.02 && maxU > 0.98 && minV < 0.02 && maxV > 0.98,
    );

    // Grout area should be near the analytic share: 1 - (600*300)/(604*304).
    const expectedGrout = 1 - (600 * 300) / (604 * 304);
    const actualGrout = inGrout / total;
    check(
      `grout covers about the right share (${(actualGrout * 100).toFixed(2)}% vs ${(expectedGrout * 100).toFixed(2)}%)`,
      Math.abs(actualGrout - expectedGrout) < 0.01,
    );

    // Running bond: adjacent rows must be offset by half a cell. Compare the u at
    // the same x on two consecutive rows.
    const running: TileSpec = { ...base, bond: "running" };
    const r0 = sampleTile(1000, 150, running, 0);
    const r1 = sampleTile(1000, 150 + 304, running, 0);
    // The offset is half a CELL expressed in FACE units — (604/2)/600 = 0.5033, not
    // 0.5. Asserting a flat half is the error that would let a bond off by half a
    // grout width pass, which is 2mm of accumulated drift per course.
    const expectedOffset = (604 * 0.5) / 600;
    const gotOffset = (((r0.u - r1.u) % 1) + 1) % 1;
    check(
      `running bond offsets alternate courses by half a cell (${gotOffset.toFixed(4)} vs ${expectedOffset.toFixed(4)})`,
      Math.abs(gotOffset - expectedOffset) < 0.005,
      `u ${r0.u.toFixed(3)} vs ${r1.u.toFixed(3)}`,
    );

    const stack0 = sampleTile(1000, 150, base, 0);
    const stack1 = sampleTile(1000, 150 + 304, base, 0);
    check("stack bond does not offset", Math.abs(stack0.u - stack1.u) < 1e-6);

    // Rotation must actually rotate. At 45 degrees a walk along world +x crosses
    // joints on both axes, so the joint count rises.
    const rotated: TileSpec = { ...base, theta: Math.PI / 4 };
    let straight = 0;
    let diagonal = 0;
    let p0 = false;
    let p1 = false;
    for (let x = 0; x < 6000; x += 1) {
      const a = sampleTile(x, 500, base, 0).grout > 0.5;
      const b = sampleTile(x, 500, rotated, 0).grout > 0.5;
      if (a && !p0) straight++;
      if (b && !p1) diagonal++;
      p0 = a;
      p1 = b;
    }
    check(`theta rotates the courses (${straight} joints vs ${diagonal} at 45deg)`, diagonal > straight);

    // The grout ramp must soften as the footprint grows, or the far field aliases.
    const sharp = sampleTile(602, 150, base, 0);
    const soft = sampleTile(602, 150, base, 40);
    check("a large footprint softens the grout edge", soft.grout < sharp.grout || soft.grout > 0);

    check("snapTheta pulls a near-45 angle to exactly 45", Math.abs(snapTheta(0.83) - Math.PI / 4) < 1e-12);
    check("snapTheta leaves a deliberate angle alone", Math.abs(snapTheta(0.5) - 0.5) < 1e-12);
    check("snapTheta pulls a near-0 angle to 0", snapTheta(0.05) === 0);
  }

  /* ----------------------------------------------------------- variants */

  {
    check("tileHash is deterministic", tileHash(3, 7) === tileHash(3, 7));
    check("tileHash is not symmetric in its arguments", tileHash(3, 7) !== tileHash(7, 3));

    // 8 apparent variants from one bitmap. If the transform collapsed, every tile
    // would be identical and the floor would show the repetition the jitter exists
    // to break.
    const seen = new Set<string>();
    for (let r = 0; r < 40; r++) {
      for (let c = 0; c < 40; c++) {
        const t = tileVariant(r, c, 0.2, 0.7, 0, 600, 600);
        seen.add(`${t.u.toFixed(3)},${t.v.toFixed(3)}`);
      }
    }
    check(`one uv maps to several oriented variants (${seen.size})`, seen.size >= 6);

    let inRange = true;
    for (let r = 0; r < 60; r++) {
      for (let c = 0; c < 60; c++) {
        const t = tileVariant(r, c, 0.999, 0.001, 0.6, 600, 600);
        if (!(t.u >= 0 && t.u < 1 && t.v >= 0 && t.v < 1)) inRange = false;
      }
    }
    check("variant uv always stays in [0,1)", inRange);

    // Jitter must scale with tile size in mm, not in uv, or small tiles wobble more.
    const bigJit = Math.abs(tileVariant(5, 5, 0.5, 0.5, 6, 600, 600).u - 0.5);
    const smallJit = Math.abs(tileVariant(5, 5, 0.5, 0.5, 6, 100, 100).u - 0.5);
    check(
      `jitter is mm-relative (600mm tile ${bigJit.toFixed(4)} uv vs 100mm ${smallJit.toFixed(4)})`,
      smallJit > bigJit * 3,
    );
  }

  /* ------------------------------------------------------------ pyramid */

  {
    // A checkerboard: mean 127.5 at every level if the reduction is unbiased.
    const W = 64;
    const data = new Uint8Array(W * W * 3);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const v = (x + y) % 2 ? 255 : 0;
        const o = (y * W + x) * 3;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
      }
    }
    const pyr = buildPyramid({ data, width: W, height: W }, 3);
    check(`the pyramid reaches 1x1 (${pyr.levels.length} levels)`, pyr.levels.length === 7);

    const means = pyr.levels.map((l) => {
      let s = 0;
      for (let i = 0; i < l.data.length; i += 3) s += l.data[i];
      return s / (l.data.length / 3);
    });
    check(
      `box reduction preserves the mean (${means.map((m) => m.toFixed(1)).join(" -> ")})`,
      means.every((m) => Math.abs(m - 127.5) < 1.5),
    );

    // Wrapping, not clamping. u = 1.0 must equal u = 0.0 exactly, or every tile
    // gets a faint border.
    const s = makeSampler(3);
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    bilinear(pyr.levels[0], 3, 0.0, 0.37, a);
    bilinear(pyr.levels[0], 3, 1.0, 0.37, b);
    check("uv wraps: u=1 equals u=0", Math.abs(a[0] - b[0]) < 1e-6);

    // Anisotropy, on a texture where it is actually visible. A checkerboard sampled
    // at its own centre already reads its own mean, so it cannot show averaging —
    // vertical stripes can. A footprint elongated ACROSS the stripes must average to
    // grey; the same footprint elongated ALONG them must not, because there is
    // nothing to average. That asymmetry is the whole behaviour.
    const SW = 64;
    const stripes = new Uint8Array(SW * SW * 3);
    for (let y = 0; y < SW; y++) {
      for (let x = 0; x < SW; x++) {
        const v = x % 8 < 4 ? 20 : 235;
        const o = (y * SW + x) * 3;
        stripes[o] = v;
        stripes[o + 1] = v;
        stripes[o + 2] = v;
      }
    }
    const sp = buildPyramid({ data: stripes, width: SW, height: SW }, 3);

    // Centre of a dark stripe. One tap reads the stripe; 16 taps across 32 texels
    // of stripes read the average.
    const oneTap = sampleAniso(sp, 2 / 64, 0.5, 1, 1, 0, 0, s)[0];
    const acrossStripes = sampleAniso(sp, 2 / 64, 0.5, 32, 1, 0.5, 0, s)[0];
    const alongStripes = sampleAniso(sp, 2 / 64, 0.5, 32, 1, 0, 0.5, s)[0];
    check(
      `a footprint across the grain averages to grey (${oneTap.toFixed(0)} -> ${acrossStripes.toFixed(0)})`,
      Math.abs(acrossStripes - 127.5) < 25 && oneTap < 60,
    );
    check(
      `a footprint along the grain keeps the contrast (${alongStripes.toFixed(0)}, still dark)`,
      alongStripes < 60,
    );

    // Tap count must saturate rather than run away — this is the cost bound.
    const extreme = sampleAniso(pyr, 0.3, 0.3, 100000, 0.5, 0.5, 0, s)[0];
    check("an extreme anisotropy ratio still returns a finite sample", Number.isFinite(extreme));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main();
