/**
 * The structure guard: did the model change anything it was not asked to?
 *
 * This is the single most valuable check in the render path. A whole-image edit
 * model succeeds at the requested change and, roughly one render in fifteen, also
 * moves a window, straightens a wall, or re-frames slightly. The output looks
 * good — that is the problem. Nobody notices until they hold it against the
 * original, by which point they have accepted a render of a different room.
 *
 * The measurement is always OUTSIDE the intended mask, on the region that should
 * be untouched. THREE signals, because each is blind to what another catches.
 * Every threshold below was measured against the project's own real kitchen photo
 * (`scripts/test-guard.ts` re-runs those measurements):
 *
 *   SSIM   — local structure over 8x8 windows. The workhorse. A 20px shift scores
 *            0.58 and a 1-degree rotation 0.48, against a 0.945 noise floor: an
 *            enormous margin. This is what catches moved windows and warped walls.
 *
 *   BLOCK MEAN DIFFERENCE — SSIM IS NEARLY BLIND TO A UNIFORM RECOLOUR, and that
 *            is not a bug in it: a repainted wall preserves structure perfectly, so
 *            SSIM correctly reports 0.99. Measured, a +3% relight scores SSIM 0.990
 *            — inside any sane clean band — while its block difference is 5.8
 *            against a 0.84 noise floor. Without this signal a model that relights
 *            the whole room passes the guard. Reported as both a mean and a WORST
 *            BLOCK, because the failure that actually happens is one repainted
 *            wall, and a frame-wide mean dilutes that toward the noise floor.
 *
 *   pHash  — global structure, 64 bits. Deliberately kept as a COARSE screen only.
 *            Measured, it returns distance 0 for a 20px shift on a 1254px photo,
 *            because 20px is under a pixel once the image is reduced to 32x32. It
 *            earns its place on gross reframing (100px shift -> distance 40) and
 *            costs a millisecond, but treating it as the primary signal — which
 *            the plan's original sketch did — would pass almost every real drift.
 *
 * SCALE NORMALISATION IS NOT OPTIONAL. fal endpoints return their own working
 * resolution, so a render arrives resampled. Measured at native resolution, a
 * harmless 1K round-trip alone scores SSIM 0.942 — under the 0.95 limit, so EVERY
 * render would be flagged. Comparing both images at a fixed 768px long edge lifts
 * that to 0.964 while real drift stays at 0.58, which is what makes a fixed
 * threshold meaningful at all.
 *
 * Everything here is local compute. Free, so there is no reason not to guard
 * every generative render.
 */
import sharp from "sharp";
import type { Mask } from "@/lib/mask";

/**
 * Long edge both images are reduced to before comparison.
 *
 * Large enough to keep real structure, small enough that resampling noise and
 * JPEG artefacts average out. 768 was measured; 1254 (native) does not work.
 */
const COMPARE_LONG_EDGE = 768;

/* --------------------------------------------------------------- perceptual hash */

const PHASH_SIZE = 32;
const PHASH_LOW = 8;

/** Precomputed DCT-II basis. Built once — 32x32 is 1024 cosines per transform. */
const COS = (() => {
  const t = new Float64Array(PHASH_SIZE * PHASH_SIZE);
  for (let u = 0; u < PHASH_SIZE; u++) {
    for (let x = 0; x < PHASH_SIZE; x++) {
      t[u * PHASH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
    }
  }
  return t;
})();

/**
 * 64-bit perceptual hash, packed into 8 bytes.
 *
 * Standard construction: 32x32 greyscale, 2D DCT, keep the top-left 8x8 low
 * frequencies, threshold against their MEDIAN. The median rather than the mean is
 * what makes it robust — one blown-out window drags a mean far enough to flip
 * half the bits, which reads as "the whole room changed".
 *
 * Bytes rather than a BigInt: the popcount below is a table lookup instead of a
 * bigint loop, and it keeps the module free of an ES2020 target requirement.
 */
export async function pHash(image: Buffer): Promise<Uint8Array> {
  const { data } = await sharp(image)
    .greyscale()
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Rows first, then columns: two 1-D passes are O(n^3) against O(n^4) for the
  // naive 2-D form, and only the top-left block is needed.
  const rows = new Float64Array(PHASH_SIZE * PHASH_SIZE);
  for (let y = 0; y < PHASH_SIZE; y++) {
    for (let u = 0; u < PHASH_LOW; u++) {
      let sum = 0;
      for (let x = 0; x < PHASH_SIZE; x++) {
        sum += data[y * PHASH_SIZE + x] * COS[u * PHASH_SIZE + x];
      }
      rows[y * PHASH_SIZE + u] = sum;
    }
  }

  const low: number[] = [];
  for (let v = 0; v < PHASH_LOW; v++) {
    for (let u = 0; u < PHASH_LOW; u++) {
      let sum = 0;
      for (let y = 0; y < PHASH_SIZE; y++) {
        sum += rows[y * PHASH_SIZE + u] * COS[v * PHASH_SIZE + y];
      }
      low.push(sum);
    }
  }

  // The DC term encodes average brightness, not structure. Excluding it from the
  // median keeps the hash about layout — a legitimately darker render should not
  // read as a structural change.
  const sorted = low.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const out = new Uint8Array(8);
  for (let i = 0; i < low.length; i++) {
    if (low[i] > median) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/** Popcount per byte value. 256 bytes, built once. */
const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
  return t;
})();

export function hamming(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += POPCOUNT[a[i] ^ b[i]];
  return n;
}

/* ------------------------------------------------------------------------ SSIM */

/**
 * Mean SSIM over 8x8 windows, restricted to a caller-supplied region.
 *
 * A window is scored only when ENTIRELY inside the region. Partially-masked
 * windows would straddle the mask boundary, where the edit legitimately differs,
 * and would report drift for a render that behaved perfectly.
 */
export function ssimMasked(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  include: (x: number, y: number) => boolean,
  win = 8,
): { ssim: number; windows: number } {
  // Constants from Wang et al. 2004, for 8-bit data: (0.01*255)^2, (0.03*255)^2.
  const C1 = 6.5025;
  const C2 = 58.5225;

  let total = 0;
  let windows = 0;

  for (let wy = 0; wy + win <= height; wy += win) {
    for (let wx = 0; wx + win <= width; wx += win) {
      let inside = true;
      for (let y = wy; y < wy + win && inside; y++) {
        for (let x = wx; x < wx + win; x++) {
          if (!include(x, y)) {
            inside = false;
            break;
          }
        }
      }
      if (!inside) continue;

      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      const n = win * win;
      for (let y = wy; y < wy + win; y++) {
        for (let x = wx; x < wx + win; x++) {
          const i = y * width + x;
          const va = a[i];
          const vb = b[i];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;

      total +=
        ((2 * ma * mb + C1) * (2 * cov + C2)) /
        ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }

  // No scoreable window means the mask covers essentially the whole frame — a
  // structural edit. Report 1 (no detected drift) rather than 0, which would
  // fail every legitimate whole-image render.
  return { ssim: windows === 0 ? 1 : total / windows, windows };
}

/* ------------------------------------------------------- mean absolute difference */

/** Side of the averaging block, in comparison-scale pixels. */
const MAD_BLOCK = 16;

/**
 * Mean absolute RGB difference over a region, averaged per BLOCK before comparing.
 *
 * Two decisions here, both measured, both load-bearing.
 *
 * BLOCK AVERAGING FIRST. Comparing pixel to pixel puts resampling noise and the
 * real signal in the same band: measured, a 1K round-trip scores 3.6 and a +3%
 * relight 7.7, barely 2x apart with a threshold squeezed between them. Averaging
 * each 16x16 block first exploits the fact that resample and JPEG noise are
 * high-frequency and zero-mean — they cancel within the block — while a relight or
 * a repaint is low-frequency and survives untouched. The same pair becomes 0.8
 * against 5.8: a 7x margin, from a change that costs nothing.
 *
 * A BLOCK MEAN, NOT A BLUR. sharp's `blur()` would average faster, but a blur
 * pulls colour across the mask boundary, so the edited region would leak into the
 * measurement of the region that must be untouched. Blocks only accumulate pixels
 * the caller included.
 *
 * MEASURED ON RGB, not on the greyscale SSIM uses. A colour grade is by
 * construction a change that mostly cancels in luma.
 */
export function blockMeanAbsDiff(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  include: (x: number, y: number) => boolean,
  block = MAD_BLOCK,
): { mad: number; worst: number; blocks: number } {
  let total = 0;
  let worst = 0;
  let blocks = 0;
  // Half a block of real pixels or the mean is dominated by whichever few pixels
  // survived the mask, which is noise pretending to be a measurement.
  const minPixels = (block * block) / 2;

  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0, n = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          if (!include(x, y)) continue;
          const p = (y * width + x) * 3;
          ar += a[p]; ag += a[p + 1]; ab += a[p + 2];
          br += b[p]; bg += b[p + 1]; bb += b[p + 2];
          n++;
        }
      }
      if (n < minPixels) continue;

      const d =
        (Math.abs(ar / n - br / n) + Math.abs(ag / n - bg / n) + Math.abs(ab / n - bb / n)) / 3;
      total += d;
      if (d > worst) worst = d;
      blocks++;
    }
  }
  return { mad: blocks === 0 ? 0 : total / blocks, worst, blocks };
}

/* -------------------------------------------------------------- scale the mask */

/**
 * Reduce a mask to the comparison grid, growing the masked region.
 *
 * A destination pixel counts as masked if ANY source pixel under it was — the
 * conservative direction. Averaging instead would let a sliver of the edited
 * region leak into the "should be untouched" measurement, where it reads as drift
 * on a render that did exactly as it was told.
 */
function scaleMaskMax(mask: Mask, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(mask.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(mask.width, Math.ceil((x + 1) * sx)));
      let hit = 0;
      for (let yy = y0; yy < y1 && !hit; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          if (mask.data[yy * mask.width + xx] !== 0) {
            hit = 255;
            break;
          }
        }
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

/* ----------------------------------------------------------------- the verdict */

export type DriftReport = {
  /** 0 = untouched outside the mask, 1 = unrecognisable. */
  score: number;
  phashDistance: number;
  ssim: number;
  /** Mean per-block RGB difference outside the mask, 0-255. */
  mad: number;
  /** The single worst block. Catches a local repaint the mean would dilute. */
  madWorst: number;
  /** Windows SSIM could score. Low means the mask covers most of the frame. */
  windows: number;
  verdict: "clean" | "suspect" | "drifted";
  detail: string;
};

/**
 * Above this many differing hash bits, global structure moved.
 *
 * A coarse backstop only. Measured, a 20px shift scores 0 and a 100px shift 40 —
 * so this fires on gross reframing and nothing subtler. SSIM is the real detector.
 */
export const PHASH_LIMIT = 10;
/**
 * Below this, local structure outside the mask changed.
 *
 * Measured at the 768px comparison scale: the worst harmless round-trip (1K down
 * and back) scores 0.964, while the mildest real drift measured — an 8px shift —
 * scores 0.721. 0.93 sits in that gap with room on both sides.
 */
export const SSIM_LIMIT = 0.93;
/**
 * Above this mean per-block difference, the whole region was recoloured or relit.
 *
 * Measured noise: 0.09 (re-encode) to 0.84 (512px round trip). Measured signal:
 * 5.8 (a +3% relight) to 6.2 (a 20px reframe). 2 sits between with 2.4x headroom
 * over the worst noise and 2.9x under the weakest signal.
 */
export const MAD_LIMIT = 2;
/**
 * Above this worst single block, part of the region was recoloured.
 *
 * The mean is the wrong statistic for the failure that actually happens: a model
 * repaints ONE wall, and averaging that over the whole frame dilutes it toward the
 * noise floor. Measured, the worst harmless block is 4.5 and a local repaint
 * exceeds 20. 12 sits between.
 */
export const MAD_WORST_LIMIT = 12;

/**
 * Above this `score`, tell the user to compare the render against the original.
 *
 * Distinct from the limits above, and deliberately so. Those decide the VERDICT,
 * which is for the log and for whoever debugs a bad render. This decides whether a
 * sentence appears in the UI, and a false warning on a good render teaches the user
 * to ignore the warning — which is worse than not having one.
 *
 * Measured, every noise case scores at or below 0.09 and every real drift at or
 * above 0.36, so this sits inside a 4x gap. `scripts/test-guard.ts` asserts that
 * gap still holds rather than trusting this comment.
 */
export const DRIFT_WARN = 0.3;

/**
 * Compare a render against its original outside the edited region.
 *
 * `mask` may be in any pixel space — it is scaled to the comparison grid here.
 * It should already be DILATED by the caller: the composite feathers across the
 * boundary by design, and scoring the feather flags every correct render.
 */
export async function measureDrift(
  original: Buffer,
  rendered: Buffer,
  mask: Mask | null,
): Promise<DriftReport> {
  const [ha, hb] = await Promise.all([pHash(original), pHash(rendered)]);
  const phashDistance = hamming(ha, hb);

  // Both images reduced to the SAME fixed grid. Not the original's own size: a
  // render arrives at whatever resolution the endpoint worked at, and comparing
  // at native scale makes resampling noise alone breach the SSIM limit.
  const meta = await sharp(original).metadata();
  const nw = meta.width ?? 0;
  const nh = meta.height ?? 0;
  const scale = Math.min(1, COMPARE_LONG_EDGE / Math.max(nw, nh, 1));
  const width = Math.max(1, Math.round(nw * scale));
  const height = Math.max(1, Math.round(nh * scale));

  const fit = (buf: Buffer) =>
    sharp(buf)
      .resize(width, height, { fit: "fill", kernel: "lanczos3" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer();
  const [ra, rb] = await Promise.all([fit(original), fit(rendered)]);

  const scaled = mask ? scaleMaskMax(mask, width, height) : null;
  const include = scaled
    ? (x: number, y: number) => scaled[y * width + x] === 0
    : () => true;

  // Rec.709 luma from the RGB already in hand, rather than a second pair of sharp
  // calls. SSIM wants structure; the diff wants colour. One decode serves both.
  const ga = new Uint8Array(width * height);
  const gb = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ga.length; i++, p += 3) {
    ga[i] = (ra[p] * 54 + ra[p + 1] * 183 + ra[p + 2] * 19) >> 8;
    gb[i] = (rb[p] * 54 + rb[p + 1] * 183 + rb[p + 2] * 19) >> 8;
  }

  const { ssim, windows } = ssimMasked(ga, gb, width, height, include);
  const { mad, worst: madWorst } = blockMeanAbsDiff(
    new Uint8Array(ra),
    new Uint8Array(rb),
    width,
    height,
    include,
  );

  // Each normalised against its own limit, then combined by MAX rather than
  // average: any one signal firing alone is a real failure, and averaging lets two
  // clean signals bury the one that caught the problem.
  //
  // All four divide by 4x their limit, so a signal sitting exactly at its limit
  // scores 0.25 — deliberately under DRIFT_WARN, which is what creates the band
  // where the log says `suspect` and the user is not interrupted. pHash used to
  // divide by 32 (half the hash bits), which put it at 0.31 AT its limit and so
  // warned the user where the other three stayed quiet. Nothing wanted that; it
  // was the one signal whose divisor was picked from its own range instead of
  // from the threshold.
  const score = Math.max(
    Math.min(1, phashDistance / (PHASH_LIMIT * 4)),
    Math.min(1, Math.max(0, (1 - ssim) / (1 - SSIM_LIMIT) / 4)),
    Math.min(1, mad / (MAD_LIMIT * 4)),
    Math.min(1, madWorst / (MAD_WORST_LIMIT * 4)),
  );

  const failures: string[] = [];
  if (phashDistance > PHASH_LIMIT) {
    failures.push(`global structure moved (pHash ${phashDistance} > ${PHASH_LIMIT})`);
  }
  if (windows > 0 && ssim < SSIM_LIMIT) {
    failures.push(`local detail changed outside the mask (SSIM ${ssim.toFixed(3)} < ${SSIM_LIMIT})`);
  }
  if (mad > MAD_LIMIT) {
    failures.push(`colour or lighting shifted across the room (mean ${mad.toFixed(1)} > ${MAD_LIMIT})`);
  } else if (madWorst > MAD_WORST_LIMIT) {
    // `else if`: a whole-room relight also produces a high worst block, and
    // reporting both reads as two independent problems and escalates the verdict
    // for what is one failure.
    failures.push(
      `part of the room was recoloured (worst block ${madWorst.toFixed(0)} > ${MAD_WORST_LIMIT})`,
    );
  }

  const verdict =
    failures.length >= 2 ? "drifted" : failures.length === 1 ? "suspect" : "clean";

  return {
    score,
    phashDistance,
    ssim,
    mad,
    madWorst,
    windows,
    verdict,
    detail:
      failures.length > 0
        ? failures.join("; ")
        : `pHash ${phashDistance}, SSIM ${ssim.toFixed(3)}, block diff ${mad.toFixed(
            1,
          )} (worst ${madWorst.toFixed(0)}) over ${windows} window(s)`,
  };
}
