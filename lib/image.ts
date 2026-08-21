/**
 * Image ingest and the quality gate.
 *
 * Two things here are load-bearing for cost and for render quality:
 *
 *  1. fal bills `ceil(w*h/1048576)` units. 512x512 and 1024x1024 cost the SAME
 *     one unit, so downscaling below 1MP saves nothing and throws away
 *     resolution. Conversely 1025x1024 costs two. `fitMegapixelBudget` lands
 *     just under a boundary on purpose.
 *
 *  2. The gate rejects photos that cannot produce a believable composite. A
 *     blown-out floor has no shading signal, so `ratio = S / median(S)` in the
 *     relighting step is flat and the material looks pasted on no matter how
 *     good the mask is. Better to refuse the upload than to sell a bad render.
 */
import sharp, { type Metadata } from "sharp";
import type { ImageQuality } from "./db/schema";

/** One fal billable unit. */
export const MEGAPIXEL = 1_048_576;

export type PreparedImage = {
  /** Re-encoded original: EXIF-rotated, colour-managed, metadata stripped. */
  original: Buffer;
  originalExt: "jpg" | "png";
  originalMime: string;
  /** The copy sent to fal and drawn on the editor canvas. */
  display: Buffer;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  exif: Record<string, unknown> | null;
};

/**
 * Largest w/h preserving aspect that fits within `units` billable megapixels.
 * Rounds DOWN — landing one pixel over a boundary doubles the bill.
 */
export function fitMegapixelBudget(
  width: number,
  height: number,
  units = 1,
): { width: number; height: number } {
  const budget = MEGAPIXEL * units;
  if (width * height <= budget) return { width, height };
  const scale = Math.sqrt(budget / (width * height));
  let w = Math.floor(width * scale);
  let h = Math.floor(height * scale);
  // Floor twice can still land over budget by a rounding hair; walk it down.
  while (w * h > budget && w > 1 && h > 1) {
    w -= 1;
    h = Math.max(1, Math.round((w / width) * height));
  }
  return { width: w, height: h };
}

/**
 * Normalise an upload: HEIC/PNG/WebP -> JPEG, EXIF rotation baked in, and a
 * display copy sized to the megapixel budget.
 *
 * `.rotate()` with no argument applies the EXIF orientation and then clears it.
 * That has to happen before anything reads width/height, or a portrait phone
 * photo gets masked in landscape and every coordinate is transposed.
 */
export async function prepareUpload(
  input: Buffer,
  opts: { megapixels?: number } = {},
): Promise<PreparedImage> {
  const probe = sharp(input, { failOn: "error" });
  const meta = await probe.metadata();

  if (!meta.width || !meta.height) {
    throw new UploadError("unreadable", "Could not read image dimensions.");
  }

  // Post-rotation dimensions: EXIF orientations 5-8 swap the axes.
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;

  // Keep PNG as PNG only when it carries meaningful alpha; a screenshot of a
  // room is better served as JPEG, and fal charges the same either way.
  const keepPng = meta.format === "png" && meta.hasAlpha === true;

  const base = sharp(input, { failOn: "error" }).rotate();

  const original = keepPng
    ? await base.clone().png({ compressionLevel: 9 }).toBuffer()
    : await base.clone().jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();

  const target = fitMegapixelBudget(width, height, opts.megapixels ?? 1);
  const display = await base
    .clone()
    .resize(target.width, target.height, { kernel: "lanczos3", fit: "fill" })
    // 4:4:4 because chroma subsampling smears grout lines and tile edges, which
    // is precisely the detail a segmentation model needs to find a boundary.
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return {
    original,
    originalExt: keepPng ? "png" : "jpg",
    originalMime: keepPng ? "image/png" : "image/jpeg",
    display,
    width,
    height,
    displayWidth: target.width,
    displayHeight: target.height,
    exif: extractExif(meta),
  };
}

/** The EXIF fields worth keeping: provenance, and a focal length for later. */
function extractExif(meta: Metadata): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (meta.orientation) out.orientation = meta.orientation;
  if (meta.density) out.density = meta.density;
  if (meta.space) out.colorSpace = meta.space;
  if (meta.chromaSubsampling) out.chromaSubsampling = meta.chromaSubsampling;
  if (meta.format) out.format = meta.format;
  if (meta.isProgressive != null) out.progressive = meta.isProgressive;
  return Object.keys(out).length ? out : null;
}

/* --------------------------------------------------------------- blur / gate */

/**
 * Variance of the Laplacian — the standard focus measure.
 *
 * Computed over a raw buffer rather than via sharp's `convolve()` because a
 * Laplacian produces negative responses and convolve writes back to uint8,
 * clamping every negative to 0. That silently discards half the edge signal and
 * makes the metric depend on which side of an edge is brighter. `offset: 128`
 * mitigates but still clips hard edges, which are the ones that matter most.
 *
 * `mask` (optional, same dimensions, non-zero = inside) restricts the measure.
 * That matters because a sharp photo of a matte floor legitimately scores low
 * over the whole frame while being perfectly sharp on the surface being edited.
 */
export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
  mask?: Uint8Array,
): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask && mask[i] === 0) continue;
      const lap =
        gray[i - width] + gray[i - 1] + gray[i + 1] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }

  if (n < 2) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Thresholds, calibrated on 512px-wide grayscale — the analysis copy is always
 * resized to that width first, because variance of the Laplacian scales with
 * resolution and a threshold tuned at 512 is meaningless at 4000.
 *
 * Measured on rendered tile references at 1200x900 (sharp -> gaussian blur):
 *
 *   surface              sharp   blur1.2  blur2.5  blur6
 *   flat matte wall        0.0      0.0      0.0     0.0
 *   mosaic 25mm           60.3     28.3      8.1     2.1
 *   tiled floor 600x900  150.6     56.7      8.6     1.4
 *   terrazzo             175.7     63.9      9.9     2.1
 *   wood plank           955.2    340.0     41.7     2.7
 *
 * Read the table before trusting the metric: a SHARP mosaic (60.3) scores lower
 * than a VISIBLY BLURRED wood plank (41.7). The measure is content-dependent, so
 * blur can only ever be a warning here, never a rejection — and a genuinely
 * featureless surface (the flat wall, 0.0) is mathematically indistinguishable
 * from an out-of-focus one. The gate says "this may be soft", not "this is soft".
 */
export const GATE = {
  analysisWidth: 512,
  /** Below this, every reference above was at blur2.5 or worse. Strong warning. */
  blurSoft: 12,
  /** Below this it *may* be soft depending on the surface. Gentle warning. */
  blurWarn: 45,
  /** Fraction of pixels at 0 or 255. Above this there is no shading to transfer. */
  clipReject: 0.05,
  clipWarn: 0.02,
} as const;

export type GateInput = {
  /** Any image buffer; it gets resized to the analysis width internally. */
  image: Buffer;
  /** Optional mask PNG at the same aspect ratio, white = the surface. */
  mask?: Buffer;
};

/**
 * Run the quality gate. Cheap: everything happens on a 512px grayscale copy.
 *
 * Exposure is a hard reject and blur is only a warning, deliberately. Blur
 * degrades a render; clipping makes the relighting step mathematically unable
 * to recover a shading field, which is not something a better prompt can fix.
 */
export async function assessQuality(input: GateInput): Promise<ImageQuality> {
  const { data, info } = await sharp(input.image)
    .resize({ width: GATE.analysisWidth, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gray = new Uint8Array(data.buffer, data.byteOffset, data.length);

  let mask: Uint8Array | undefined;
  if (input.mask) {
    const m = await sharp(input.mask)
      .resize(info.width, info.height, { fit: "fill", kernel: "nearest" })
      .greyscale()
      .raw()
      .toBuffer();
    mask = new Uint8Array(m.buffer, m.byteOffset, m.length);
  }

  const blurVariance = laplacianVariance(gray, info.width, info.height, mask);

  let low = 0;
  let high = 0;
  let total = 0;
  for (let i = 0; i < gray.length; i++) {
    if (mask && mask[i] === 0) continue;
    total++;
    if (gray[i] === 0) low++;
    else if (gray[i] === 255) high++;
  }

  const clippedLowPct = total ? low / total : 0;
  const clippedHighPct = total ? high / total : 0;

  const warnings: string[] = [];
  let verdict: ImageQuality["verdict"] = "ok";

  if (blurVariance < GATE.blurSoft) {
    warnings.push(
      "This photo looks soft. Edges and grout lines may not survive the render — try again with more light or a steadier shot.",
    );
    verdict = "warn";
  } else if (blurVariance < GATE.blurWarn) {
    warnings.push("Focus may be slightly soft. Fine detail could come out muted.");
    verdict = "warn";
  }

  if (clippedHighPct > GATE.clipReject) {
    warnings.push(
      `${(clippedHighPct * 100).toFixed(0)}% of the frame is pure white — blown-out highlights carry no shading information, so new materials will look pasted on. Try exposing for the room rather than the window.`,
    );
    verdict = "reject";
  } else if (clippedHighPct > GATE.clipWarn) {
    warnings.push("Some highlights are clipped. Bright areas may render flat.");
    if (verdict === "ok") verdict = "warn";
  }

  if (clippedLowPct > GATE.clipReject) {
    warnings.push(
      `${(clippedLowPct * 100).toFixed(0)}% of the frame is pure black — crushed shadows leave nothing to relight. More even lighting will help.`,
    );
    verdict = "reject";
  } else if (clippedLowPct > GATE.clipWarn) {
    warnings.push("Some shadows are crushed. Dark areas may render flat.");
    if (verdict === "ok") verdict = "warn";
  }

  return {
    blurVariance: Math.round(blurVariance * 100) / 100,
    clippedLowPct: Math.round(clippedLowPct * 10000) / 10000,
    clippedHighPct: Math.round(clippedHighPct * 10000) / 10000,
    verdict,
    warnings,
  };
}

/* -------------------------------------------------------------------- errors */

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
]);

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
