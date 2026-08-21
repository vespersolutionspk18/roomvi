/**
 * Shading transfer — the step that makes a projected bitmap look photographed.
 *
 * THE NAIVE VERSION IS WRONG, and it is wrong in a way that reads as a rendering
 * bug rather than a design error. "Keep L, replace chroma" in LAB is the obvious
 * move and it fails outright: it retains the OLD surface's lightness, so dark
 * walnut replaced by white marble comes back as dark marble. You have recoloured
 * the old floor, not installed a new one. Anything that preserves absolute
 * luminance has this defect.
 *
 * What must be preserved is not lightness but ILLUMINATION — the ratio between
 * how lit each point is and how lit the surface is on average. That is a
 * multiplicative field, and multiplying the new material by it puts the room's own
 * light on the new surface:
 *
 *   1. linearize          (in gamma space this crushes shadows — second-biggest
 *                          cause of the pasted look, after aliasing)
 *   2. Y = luminance
 *   3. S = edge-preserving lowpass of log Y      <- shading, without the texture
 *   4. ratio = S / median(S inside the mask)     <- median, not mean: robust to a
 *                                                   blown window in frame
 *   5. out = tile_linear * ratio^gamma
 *   6. tint toward the room's illuminant
 *   7. re-encode
 *
 * CONTACT SHADOWS COME FREE. The `ratio` field carries the dark band where a chair
 * meets the floor, so it lands on the new material without being detected or
 * modelled. That is the strongest argument for multiplicative transfer over
 * anything that replaces luminance: the hardest part of the problem solves itself.
 *
 * AND NO POISSON BLENDING. It solves globally, which shifts the interior toward
 * the surround — your measured marble drifts toward the old oak's hue. Colour
 * fidelity is the product here; a seam is cosmetic and a wrong colour is a lie.
 */
import sharp from "sharp";
import { linearToSrgb, srgbToLinear } from "@/lib/color";
import type { Mask } from "@/lib/mask";

/**
 * 8-bit sRGB -> linear, precomputed. The inner loops run this per subpixel.
 *
 * `srgbToLinear` takes 0..255, so the index goes in RAW. Passing `i / 255` scales the
 * whole table down by ~255x, which does not throw and does not look like a unit bug —
 * it looks like a slightly dark render, and everything downstream (median, ratio,
 * grey-world tint) is scale-invariant enough to hide it. Check `LIN[255] === 1`.
 */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

export type ShadingField = {
  /** Per-pixel illumination ratio, 1.0 = the surface's own average. */
  ratio: Float32Array;
  width: number;
  height: number;
  /** Grey-world illuminant of the masked region, normalized to luminance 1. */
  tint: [number, number, number];
  /** Diagnostics — surfaced in the measurement overlay, not just logged. */
  stats: { median: number; p05: number; p95: number; clampedPct: number };
};

export type ShadingOptions = {
  /** Guided-filter radius as a fraction of the image diagonal. */
  radiusFrac?: number;
  /** Regularization. Larger = smoother, less edge-preserving. */
  eps?: number;
  /** Ratio clamp. Wider passes more of the room's contrast and more of its noise. */
  clamp?: [number, number];
  /**
   * Half-width, px, of the dark features to erase before filtering — the old
   * surface's own grout lines. 0 disables. Above ~4 it starts eating real contact
   * shadows, which are the thing this whole module exists to preserve.
   */
  jointPx?: number;
};

/**
 * Separable sliding-window extremum filter. `sign` +1 for max (dilate), -1 for min.
 *
 * O(r) per pixel rather than the O(1) van Herk/Gil-Werman, which is the right trade
 * at r=3: the bookkeeping for the constant-time version costs more than 7 compares.
 */
function extremum(src: Float32Array, w: number, h: number, r: number, sign: 1 | -1): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let best = src[row + x];
      for (let k = -r; k <= r; k++) {
        const v = src[row + Math.min(w - 1, Math.max(0, x + k))];
        if (v * sign > best * sign) best = v;
      }
      tmp[row + x] = best;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let best = tmp[y * w + x];
      for (let k = -r; k <= r; k++) {
        const v = tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
        if (v * sign > best * sign) best = v;
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

/**
 * Grey closing: remove dark features THINNER than 2r, keep everything broader.
 *
 * This is what stops the OLD floor showing through the new one. The guided filter is
 * edge-preserving by design, and the old surface's grout lines are edges — so they
 * survive into the shading field and get multiplied onto the new material. The result
 * is a render where you can read the previous floor's layout through a completely
 * different tile, which is the single most damaging artefact for a product whose claim
 * is "this is your room with that material in it".
 *
 * Raising `eps` instead would smooth the joints away, but it also smears the contact
 * shadow under a chair leg into a soft blob — and those shadows are the reason the
 * multiplicative approach is worth the trouble. Scale separates the two cleanly:
 * illumination varies broadly (or at broad occlusion boundaries), while a grout joint
 * is a few pixels wide at any plausible viewing distance. So discriminate on WIDTH,
 * before the filter that cannot tell them apart, and the guided filter then keeps the
 * shadow edges it is good at.
 */
function removeThinDark(logY: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return logY;
  return extremum(extremum(logY, w, h, r, 1), w, h, r, -1);
}

/**
 * Box blur via sharp, on a Float32 plane carried as raw bytes.
 *
 * sharp's `blur()` is Gaussian, not box, and only takes uint8 — so the guided
 * filter's box primitive is implemented directly here as a separable summed pass.
 * Round-tripping floats through uint8 would quantize the shading field to 1/255,
 * which is visible as banding in a gradient across a wall.
 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;

  // Horizontal. Running sum with edge clamping, so the filter does not darken at
  // the borders (which would put a false vignette on every render).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum -= src[row + Math.min(w - 1, Math.max(0, x - r))];
      sum += src[row + Math.min(w - 1, Math.max(0, x + r + 1))];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum -= tmp[Math.min(h - 1, Math.max(0, y - r)) * w + x];
      sum += tmp[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
    }
  }
  return out;
}

/**
 * Guided filter, self-guided (He, Sun, Tang).
 *
 * Five box passes over I, p, I*p and I^2. Self-guided means it behaves as an
 * edge-preserving smoother: it keeps the shadow BOUNDARY sharp while removing the
 * texture inside it. A plain Gaussian would smear the shadow edge into a soft
 * gradient, and the composite then shows the new material lit by a shadow that
 * does not line up with anything in the photo.
 */
function guidedSelf(I: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const meanI = boxBlur(I, w, h, r);
  const II = new Float32Array(w * h);
  for (let i = 0; i < II.length; i++) II[i] = I[i] * I[i];
  const meanII = boxBlur(II, w, h, r);

  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    a[i] = varI / (varI + eps);
    b[i] = meanI[i] * (1 - a[i]);
  }
  const meanA = boxBlur(a, w, h, r);
  const meanB = boxBlur(b, w, h, r);

  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = meanA[i] * I[i] + meanB[i];
  return out;
}

/** Median of the masked samples. O(n) would be nicer; n is small and sort is clear. */
function maskedMedian(values: Float32Array, mask: Uint8Array): number {
  const picked: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) picked.push(values[i]);
  if (picked.length === 0) return 1;
  picked.sort((x, y) => x - y);
  return picked[picked.length >> 1];
}

/**
 * Extract the illumination field from the photo, inside the mask.
 *
 * `photo` is raw RGB at `width` x `height`, which must match the mask.
 */
export function shadingField(
  photo: Uint8Array,
  width: number,
  height: number,
  mask: Mask,
  opts: ShadingOptions = {},
): ShadingField {
  const n = width * height;
  const radiusFrac = opts.radiusFrac ?? 0.03;
  const eps = opts.eps ?? 0.02 * 0.02;
  const [lo, hi] = opts.clamp ?? [0.25, 2.5];

  // log Y, not Y. Illumination is multiplicative, so it is ADDITIVE in log space —
  // which is what makes a linear smoother the right tool for separating it from
  // reflectance. Filtering Y directly biases the result toward the bright regions.
  const logY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const y = 0.2126 * LIN[photo[o]] + 0.7152 * LIN[photo[o + 1]] + 0.0722 * LIN[photo[o + 2]];
    logY[i] = Math.log(y + 1e-4);
  }

  const r = Math.max(2, Math.round(Math.hypot(width, height) * radiusFrac));
  // Erase the old surface's joints BEFORE the edge-preserving filter, which would
  // otherwise faithfully preserve them and stamp the previous floor's layout onto
  // the new material.
  const closed = removeThinDark(logY, width, height, opts.jointPx ?? 3);
  const logS = guidedSelf(closed, width, height, r, eps);

  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = Math.exp(logS[i]);

  // Median over the MASK, not the frame. The frame's median describes the room; the
  // ratio must be relative to this surface's own average lighting or the new
  // material comes out uniformly too dark or too bright.
  const median = Math.max(1e-6, maskedMedian(S, mask.data));

  const ratio = new Float32Array(n);
  let clamped = 0;
  for (let i = 0; i < n; i++) {
    const v = S[i] / median;
    if (v < lo || v > hi) {
      clamped++;
      ratio[i] = Math.min(hi, Math.max(lo, v));
    } else {
      ratio[i] = v;
    }
  }

  // Grey-world illuminant of the masked region. The room's light is rarely neutral
  // — tungsten downlights on a white floor are visibly warm — and a material
  // rendered under D65 in a tungsten room reads as a cutout no matter how well the
  // geometry lines up.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!mask.data[i]) continue;
    const o = i * 3;
    sr += LIN[photo[o]];
    sg += LIN[photo[o + 1]];
    sb += LIN[photo[o + 2]];
    count++;
  }
  let tint: [number, number, number] = [1, 1, 1];
  if (count > 0) {
    sr /= count;
    sg /= count;
    sb /= count;
    const y = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
    if (y > 1e-6) tint = [sr / y, sg / y, sb / y];
  }

  const sorted: number[] = [];
  for (let i = 0; i < n; i++) if (mask.data[i]) sorted.push(ratio[i]);
  sorted.sort((x, y) => x - y);
  const pick = (q: number) => (sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : 1);

  return {
    ratio,
    width,
    height,
    tint,
    stats: {
      median,
      p05: pick(0.05),
      p95: pick(0.95),
      clampedPct: (clamped / n) * 100,
    },
  };
}

export type RelightOptions = {
  /** Shading strength. 1.0 = full transfer; below that flattens toward flat lighting. */
  gamma?: number;
  /** How much of the room's colour cast to apply, 0-1. */
  tintStrength?: number;
};

/**
 * Apply a shading field to a linear-light RGB buffer, writing 8-bit sRGB.
 *
 * `tile` is linear float RGB (0-1) — the sampler's output already lives there, so
 * no round trip through sRGB. `out` is 8-bit sRGB RGBA, alpha untouched.
 */
export function relight(
  tile: Float32Array,
  field: ShadingField,
  out: Uint8Array,
  opts: RelightOptions = {},
): void {
  const gamma = opts.gamma ?? 0.9;
  const tintStrength = opts.tintStrength ?? 0.45;
  const n = field.width * field.height;

  // Blend the illuminant toward neutral once, outside the loop.
  const tr = 1 + (field.tint[0] - 1) * tintStrength;
  const tg = 1 + (field.tint[1] - 1) * tintStrength;
  const tb = 1 + (field.tint[2] - 1) * tintStrength;

  // gamma == 1 is the common case and skipping `pow` on every pixel is worth the
  // branch: at 2MP that is 2 million transcendentals.
  const unit = gamma === 1;

  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const q = i * 4;
    const k = unit ? field.ratio[i] : field.ratio[i] ** gamma;
    let r = tile[o] * k * tr;
    let g = tile[o + 1] * k * tg;
    let b = tile[o + 2] * k * tb;

    // HUE-PRESERVING HIGHLIGHT ROLLOFF. Clamping each channel independently is the
    // obvious move and it desaturates: on a bright floor the ratio pushes a saturated
    // material's dominant channel past 1 while the others stay under, so terracotta's
    // red clips alone and the highlights wash out toward grey — measured at 11% chroma
    // drift, scaling with the material's saturation (near-neutral marble showed 0.1%).
    // Dividing all three by the max instead keeps the ratios exact and spends the
    // overflow on lightness, which is the channel the eye forgives.
    const m = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (m > 1) {
      r /= m;
      g /= m;
      b /= m;
    }

    // `linearToSrgb` already returns 0..255, rounded and clamped. Multiplying by 255
    // again overflows the Uint8Array, which WRAPS modulo 256 rather than clipping —
    // so a pale marble comes back as arbitrary noise that reads as blown-out white,
    // and a mid-tone terracotta comes back saturated red. Not a subtle failure, but
    // an easy one to write, because the mirror-image mistake (`* 255` on the way in)
    // is genuinely required by some sRGB helpers.
    out[q] = linearToSrgb(r);
    out[q + 1] = linearToSrgb(g);
    out[q + 2] = linearToSrgb(b);
  }
}

/**
 * Matting: a soft alpha whose ramp sits INSIDE the true surface.
 *
 * Never composite a binary mask. The mask boundary and the photo's own gradient
 * boundary disagree by a pixel or two everywhere, and a hard edge makes that
 * disagreement a bright halo along every skirting board — the single most
 * recognisable compositing failure after aliasing.
 *
 * Eroding first is what stops the ramp bleeding OUTWARD onto the skirting board:
 * the gradient then lives entirely within pixels that really are floor.
 */
export async function matte(mask: Mask, featherPx = 2): Promise<Buffer> {
  const { width, height } = mask;
  // sharp's morphology is inverted (libvips treats black as foreground), so
  // `dilate` shrinks the white region. Named through the wrapper semantics in
  // lib/mask.ts to keep that trap in one place.
  const shrunk = await sharp(Buffer.from(mask.data), {
    raw: { width, height, channels: 1 },
  })
    .dilate(Math.max(1, Math.round(featherPx)))
    .blur(Math.max(0.3, featherPx))
    .raw()
    .toBuffer();
  return shrunk;
}
