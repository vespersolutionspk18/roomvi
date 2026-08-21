/**
 * Composite a generative result back onto the original through the mask.
 *
 * THIS IS THE CORE TRICK of the generative path, and it is worth being precise
 * about why it exists. A whole-image edit model produces better material and
 * lighting than an inpaint model — it sees the whole room, so its new floor
 * reflects the actual window. But it also rewrites every pixel, including the
 * ones nobody asked about. An inpaint model touches only the mask, but judges the
 * material from a keyhole.
 *
 * Compositing gets both: generate whole-image, then keep the model's pixels ONLY
 * inside the mask and the photograph's everywhere else. Outside the mask the
 * result is bit-identical to the original by construction, which is a guarantee no
 * prompt can offer.
 *
 * Two things make it invisible rather than obviously cut out:
 *
 *  1. A FEATHERED ALPHA, not a binary one. A hard mask edge produces a 1px seam
 *     that reads as a sticker, because the mask boundary and the photograph's own
 *     gradient boundary never agree exactly.
 *
 *  2. THE FEATHER SITS INSIDE THE SURFACE. Erode before blurring, so the ramp
 *     eats into the new material rather than spilling onto the skirting board.
 *     Blurring a mask in place pushes half the ramp outward, and a floor material
 *     climbing 3px up the wall is the classic halo.
 */
import sharp from "sharp";
import { dilateMask, encodeMask, erodeMask, type Mask } from "@/lib/mask";

export type CompositeOptions = {
  /** Feather width in px at the mask edge. Scaled to the image if omitted. */
  featherPx?: number;
  /** JPEG quality of the stored render. */
  quality?: number;
};

/**
 * Build the alpha channel used for the composite.
 *
 * Returned as a single-band buffer at the mask's own size so callers can reuse it
 * for the drift measurement — the guard must exclude exactly the region the
 * composite touched, and rebuilding it from the binary mask would exclude the
 * wrong band.
 *
 * NOTE the erode/blur/clip sequence, and do not shorten it:
 *
 *  - Erosion goes through `erodeMask`, NOT `sharp.erode()`. sharp's morphology is
 *    inverted (libvips treats black as foreground) — `sharp.erode()` GROWS the
 *    white region. Calling it directly here spilled the ramp outward and produced
 *    the exact halo this function exists to prevent; `scripts/test-guard.ts`
 *    caught it as 79872 lit pixels against a 74240-pixel mask.
 *  - sigma is radius/3, so the Gaussian's 3-sigma reach lands back on the original
 *    boundary rather than 1.5x past it.
 *  - The final clip is what makes "the ramp stays inside the surface" an invariant
 *    instead of a consequence of tuning. A Gaussian has infinite support; a
 *    guarantee cannot rest on its tail being small.
 */
export async function featherAlpha(mask: Mask, featherPx: number): Promise<Buffer> {
  const radius = Math.max(1, Math.round(featherPx));
  const inner = await erodeMask(mask, radius);

  // sharp's blur sigma is not a radius. sigma ~ radius/3 puts the ramp's useful
  // extent at the requested width instead of three times it.
  const sigma = Math.max(0.3, radius / 3);
  const { data, info } = await sharp(await encodeMask(inner))
    .blur(sigma)
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });

  // A b-w PNG can still decode to 3 identical channels depending on what the
  // pipeline did upstream — measured, and the reason mask.ts checks the same way.
  const n = mask.width * mask.height;
  const alpha = Buffer.allocUnsafe(n);
  const stride = info.channels;
  for (let i = 0; i < n; i++) {
    // Hard clip to the original mask. Outside it the alpha is zero by definition,
    // which is what the bit-equality assertion downstream depends on.
    alpha[i] = mask.data[i] === 0 ? 0 : data[i * stride];
  }
  return alpha;
}

/**
 * Replace the masked region of `original` with the same region of `edited`.
 *
 * `edited` is resized to the original's dimensions first. fal endpoints return
 * their own working resolution — nano-banana-2 at "1K" does not return the input's
 * pixel dimensions — and compositing at mismatched sizes silently offsets the
 * whole edit.
 */
export async function compositeThroughMask(
  original: Buffer,
  edited: Buffer,
  mask: Mask,
  opts: CompositeOptions = {},
): Promise<{ jpeg: Buffer; width: number; height: number; alpha: Buffer }> {
  const meta = await sharp(original).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) throw new Error("composite: original has no dimensions");
  if (mask.width !== width || mask.height !== height) {
    throw new Error(
      `composite: mask ${mask.width}x${mask.height} does not match photo ${width}x${height}`,
    );
  }

  // ~0.4% of the diagonal: about 6px at 1254x836. Fixed pixel feathers look
  // right at one resolution and wrong at every other.
  const featherPx = opts.featherPx ?? Math.max(2, Math.round(Math.hypot(width, height) * 0.004));
  const alpha = await featherAlpha(mask, featherPx);

  const base = await sharp(original).removeAlpha().raw().toBuffer();
  const top = await sharp(edited)
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer();

  // Blended by hand rather than via sharp's `composite`. Doing it here keeps the
  // arithmetic in 8-bit RGB with no intermediate colourspace conversion, which is
  // what allows the outside-mask bit-equality assertion to hold exactly. A
  // premultiply/unpremultiply round-trip through libvips does not.
  const out = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0, p = 0; i < alpha.length; i++, p += 3) {
    const a = alpha[i];
    if (a === 0) {
      // The common case, and the one the guarantee rests on: copied verbatim.
      out[p] = base[p];
      out[p + 1] = base[p + 1];
      out[p + 2] = base[p + 2];
    } else if (a === 255) {
      out[p] = top[p];
      out[p + 1] = top[p + 1];
      out[p + 2] = top[p + 2];
    } else {
      // +127 rather than a floor: rounding down biases every ramp pixel toward
      // the original, which shows up as a faint dark rim along the feather.
      out[p] = (top[p] * a + base[p] * (255 - a) + 127) / 255;
      out[p + 1] = (top[p + 1] * a + base[p + 1] * (255 - a) + 127) / 255;
      out[p + 2] = (top[p + 2] * a + base[p + 2] * (255 - a) + 127) / 255;
    }
  }

  const jpeg = await sharp(out, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: opts.quality ?? 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return { jpeg, width, height, alpha };
}

/**
 * Verify a composite left the outside-mask region bit-identical.
 *
 * Worth more than any perceptual metric, and costs microseconds. It catches a
 * stray global operation (a `normalise()`, an sRGB round-trip), an off-by-one in
 * the mask, or a resize that shifted the edit by a pixel — each of which is
 * invisible in a thumbnail and fatal to the guarantee this module advertises.
 *
 * Must run on RAW buffers. JPEG is lossy, so re-encoding breaks bit-equality even
 * when the composite was perfect.
 */
export function assertOutsideUntouched(
  originalRaw: Buffer,
  compositeRaw: Buffer,
  alpha: Buffer,
): { ok: boolean; differing: number; checked: number } {
  let differing = 0;
  let checked = 0;
  for (let i = 0, p = 0; i < alpha.length; i++, p += 3) {
    if (alpha[i] !== 0) continue;
    checked++;
    if (
      originalRaw[p] !== compositeRaw[p] ||
      originalRaw[p + 1] !== compositeRaw[p + 1] ||
      originalRaw[p + 2] !== compositeRaw[p + 2]
    ) {
      differing++;
    }
  }
  return { ok: differing === 0, differing, checked };
}

/**
 * The mask region to EXCLUDE from drift measurement.
 *
 * Wider than the composite's own feather: the model's edit can influence a few
 * pixels past the boundary through its own interpretation of the scene, and the
 * JPEG round-trip smears the ramp slightly further. Measuring drift right up to
 * the feather's edge reports failure on renders that behaved correctly.
 *
 * Grows via `dilateMask` for the reason spelled out in `featherAlpha`: sharp's
 * `dilate()` shrinks the white region, so calling it here narrowed the exclusion
 * zone and put the feather itself back inside the measured area.
 */
export async function guardMask(mask: Mask, dilatePx: number): Promise<Mask> {
  return dilateMask(mask, Math.max(1, Math.round(dilatePx)));
}
