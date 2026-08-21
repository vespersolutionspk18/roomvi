/**
 * Mask utilities: measure, judge, clean, combine.
 *
 * The reason this exists before any segmentation code: "did the model return a
 * usable mask?" has to be a MEASUREMENT, not an impression. A segmenter asked
 * for "the floor" will happily return the whole frame, or a scattering of
 * speckle, or a 3-pixel blob, and all three look plausible in a thumbnail. Each
 * failure has a signature that is cheap to compute and hard to argue with:
 *
 *   whole-frame grab   -> coverage ~1.0, touches every edge
 *   nothing found      -> coverage ~0
 *   speckle            -> many components, largest holds a small share
 *   right idea         -> one dominant component, plausible coverage and position
 *
 * Everything here works on a raw single-channel buffer. Nothing round-trips
 * through PNG mid-pipeline, because re-encoding is where alpha and bit depth
 * quietly change under you.
 */
import sharp from "sharp";

export type Mask = {
  data: Uint8Array;
  width: number;
  height: number;
};

/** Anything at or above this is "inside the mask". */
const ON = 128;

/**
 * Decode any mask-ish image to one byte per pixel.
 *
 * Handles the three shapes fal endpoints actually return: a 1-channel PNG, an
 * RGB PNG that is visually black-and-white, and an RGBA PNG carrying the mask in
 * ALPHA with black RGB — that last one reads as an all-zero mask if you only
 * look at the colour channels, which is a silently wrong answer rather than an
 * error.
 */
export async function decodeMask(input: Buffer): Promise<Mask> {
  const img = sharp(input);
  const meta = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const out = new Uint8Array(width * height);

  const alphaCarriesMask = channels === 4 && (await isAlphaTheMask(data, width, height));

  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    if (alphaCarriesMask) {
      out[i] = data[p + 3] >= ON ? 255 : 0;
    } else if (channels === 1) {
      out[i] = data[p] >= ON ? 255 : 0;
    } else {
      // Luma rather than a single channel: a mask tinted by a model's overlay
      // still thresholds correctly.
      const y = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      out[i] = y >= ON ? 255 : 0;
    }
  }

  void meta;
  return { data: out, width, height };
}

/** True when RGB is ~uniformly dark but alpha varies — i.e. the mask is in alpha. */
async function isAlphaTheMask(data: Buffer, width: number, height: number): Promise<boolean> {
  let rgbOn = 0;
  let alphaOn = 0;
  const n = width * height;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    if (y >= ON) rgbOn++;
    if (data[p + 3] >= ON) alphaOn++;
  }
  // Alpha says something, RGB says nothing.
  return alphaOn > n * 0.001 && rgbOn < n * 0.001;
}

export type MaskStats = {
  width: number;
  height: number;
  /** Fraction of the frame inside the mask, 0..1. */
  coverage: number;
  /** Connected components above a noise floor. */
  components: number;
  /** Fraction of masked pixels belonging to the largest component. */
  largestShare: number;
  /** Bounding box of the largest component, in pixels. */
  bbox: { x: number; y: number; w: number; h: number };
  /**
   * Bounding box of ALL masked pixels, in pixels.
   *
   * Distinct from `bbox` because that one describes the largest component only,
   * which understates a legitimately fragmented surface — a wall split into 13
   * pieces by cabinets and doorways would report the extent of one piece. The
   * editor's zone overlay needs the full extent, so it uses this.
   */
  bboxAll: { x: number; y: number; w: number; h: number };
  /** Which frame edges the mask touches — a floor should reach the bottom. */
  touches: { top: boolean; bottom: boolean; left: boolean; right: boolean };
  /** Centroid in normalized coords; y near 1 is low in frame. */
  centroid: { x: number; y: number };
  /** Masked area above/below the horizontal midline — separates floor from ceiling. */
  upperHalfShare: number;
};

/**
 * Connected-component labelling, 4-connectivity, iterative.
 *
 * Iterative rather than recursive on purpose: a floor mask on a 12MP photo is
 * millions of connected pixels, and the recursive version blows the stack on
 * exactly the inputs that matter most.
 */
export function analyzeMask(mask: Mask): MaskStats {
  const { data, width, height } = mask;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  const stack = new Int32Array(n);

  let on = 0;
  for (let i = 0; i < n; i++) if (data[i]) on++;

  for (let start = 0; start < n; start++) {
    if (!data[start] || labels[start] !== -1) continue;
    const id = sizes.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let size = 0;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      size++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;

      if (x > 0 && data[p - 1] && labels[p - 1] === -1) {
        labels[p - 1] = id;
        stack[sp++] = p - 1;
      }
      if (x + 1 < width && data[p + 1] && labels[p + 1] === -1) {
        labels[p + 1] = id;
        stack[sp++] = p + 1;
      }
      if (y > 0 && data[p - width] && labels[p - width] === -1) {
        labels[p - width] = id;
        stack[sp++] = p - width;
      }
      if (y + 1 < height && data[p + width] && labels[p + width] === -1) {
        labels[p + width] = id;
        stack[sp++] = p + width;
      }
    }
    sizes.push(size);
    boxes.push({ x0, y0, x1, y1 });
  }

  // Ignore components under 0.01% of the frame: JPEG ringing along a mask edge
  // produces dozens of them and they would swamp the component count.
  const floor = Math.max(16, Math.round(n * 0.0001));
  const significant = sizes.filter((s) => s >= floor).length;

  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[largest]) largest = i;

  const box = sizes.length
    ? boxes[largest]
    : { x0: 0, y0: 0, x1: -1, y1: -1 };

  let sx = 0;
  let sy = 0;
  let upper = 0;
  let ax0 = width;
  let ay0 = height;
  let ax1 = -1;
  let ay1 = -1;
  const mid = height / 2;
  for (let i = 0; i < n; i++) {
    if (!data[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    sx += x;
    sy += y;
    if (y < mid) upper++;
    if (x < ax0) ax0 = x;
    if (y < ay0) ay0 = y;
    if (x > ax1) ax1 = x;
    if (y > ay1) ay1 = y;
  }

  const edge = (() => {
    let top = false;
    let bottom = false;
    let left = false;
    let right = false;
    for (let x = 0; x < width; x++) {
      if (data[x]) top = true;
      if (data[(height - 1) * width + x]) bottom = true;
    }
    for (let y = 0; y < height; y++) {
      if (data[y * width]) left = true;
      if (data[y * width + width - 1]) right = true;
    }
    return { top, bottom, left, right };
  })();

  return {
    width,
    height,
    coverage: on / n,
    components: significant,
    largestShare: on ? sizes[largest] / on : 0,
    bbox: { x: box.x0, y: box.y0, w: box.x1 - box.x0 + 1, h: box.y1 - box.y0 + 1 },
    bboxAll: on
      ? { x: ax0, y: ay0, w: ax1 - ax0 + 1, h: ay1 - ay0 + 1 }
      : { x: 0, y: 0, w: 0, h: 0 },
    touches: edge,
    centroid: on ? { x: sx / on / width, y: sy / on / height } : { x: 0, y: 0 },
    upperHalfShare: on ? upper / on : 0,
  };
}

export type Verdict = {
  usable: boolean;
  /** Short reason, for the spike's results table. */
  note: string;
};

/**
 * How much of the frame each surface plausibly occupies, and where it can sit.
 *
 * These exist because of a real false pass. The Phase 3.5 spike reported 11/11
 * masks "usable" on a wide kitchen shot, including a "wall" holding 1.9% of the
 * frame — a sliver beside a door in a photo whose beige wall spans a third of
 * the image. Every generic check passed it: not empty, not the whole frame, one
 * clean component. Only a scale expectation catches it.
 *
 * The asymmetry is deliberate and is the whole point of a per-kind table:
 *
 *   a FLOOR at 3.5% is correct — an island and four stools legitimately hide
 *   almost all of it, so a low floor is normal
 *   a WALL at 1.9% is a miss — nothing occludes a wall that thoroughly
 *
 * A single global `minCoverage` cannot express that, and either passes the bad
 * wall or rejects the good floor.
 *
 * Loose on purpose, and calibrated on few photos: these are "did it find
 * something of roughly the right size", not tight bounds. Over-tightening turns
 * a correctable ~80% mask into a rejection, and brush correction exists for
 * exactly the residue.
 */
const EXPECTED: Record<string, { min: number; max: number }> = {
  // Wide-angle interiors put the near floor under furniture; large frames of it
  // are the exception, not the rule.
  floor: { min: 0.015, max: 0.65 },
  // The one surface with no plausible small case. Walls are the backdrop.
  wall: { min: 0.07, max: 0.75 },
  // Rarely more than a band along the top unless the camera is tilted up.
  ceiling: { min: 0.02, max: 0.45 },
  countertop: { min: 0.02, max: 0.4 },
  // A backsplash is a strip by definition — a large one means it took the wall.
  backsplash: { min: 0.01, max: 0.25 },
  cupboard: { min: 0.03, max: 0.5 },
  window: { min: 0.005, max: 0.35 },
};

/**
 * Surfaces that are legitimately split into many pieces by what sits in front of
 * them, so a high component count is geometry rather than noise.
 *
 * Measured, not assumed. A correct "the wall" mask on the spike photo came back
 * as 13 components at 14.6% coverage — left of the window, behind the doorway,
 * above the cabinets, the strip behind the backsplash — and the generic speckle
 * rule rejected it. The overlay showed every piece was real wall.
 *
 * `cupboard` and `window` are here for the same reason and by definition: N
 * cabinet doors and N window panes are N components before any union.
 */
const NATURALLY_FRAGMENTED = new Set(["wall", "cupboard", "window"]);

/**
 * Judge a mask against what the requested surface should plausibly look like.
 *
 * The expectations are deliberately loose — this answers "did the model find the
 * right KIND of thing", not "is the boundary pixel-perfect". Brush correction
 * ships in v1 precisely because ~80% is the realistic ceiling.
 *
 * What this CANNOT do, at any tightness: tell you the mask is on the right
 * object. A wall and a floor of equal size and position score identically. That
 * check is a human looking at an overlay, which is why `overlay()` exists.
 */
export function judgeMask(kind: string, s: MaskStats): Verdict {
  if (s.coverage < 0.005) return { usable: false, note: "empty — found nothing" };
  if (s.coverage > 0.92) return { usable: false, note: "grabbed the whole frame" };

  // Speckle: many pieces, none of them dominant. Skipped for surfaces that
  // furniture and joinery genuinely cut into pieces — for those, total coverage
  // is the honest signal and the scale bounds below carry the check.
  if (!NATURALLY_FRAGMENTED.has(kind) && s.largestShare < 0.4 && s.components > 8) {
    return { usable: false, note: `speckle — ${s.components} fragments` };
  }
  // Even a fragmented surface has a limit: hundreds of pieces is dust, not a
  // wall behind cabinets.
  if (s.components > 60) return { usable: false, note: `dust — ${s.components} fragments` };

  const pct = (s.coverage * 100).toFixed(1);
  const expect = EXPECTED[kind];
  if (expect) {
    if (s.coverage < expect.min) {
      return { usable: false, note: `only ${pct}% — too small for a ${kind}` };
    }
    if (s.coverage > expect.max) {
      return { usable: false, note: `${pct}% — too large for a ${kind}, likely spilled` };
    }
  }

  // Position sanity, per surface type. A "floor" high in frame is a wall.
  if (kind === "floor") {
    if (!s.touches.bottom) return { usable: false, note: "does not reach the bottom edge" };
    if (s.upperHalfShare > 0.6) return { usable: false, note: "sits high in frame — not a floor" };
  }
  if (kind === "ceiling") {
    if (!s.touches.top) return { usable: false, note: "does not reach the top edge" };
  }

  return { usable: true, note: `coverage ${pct}%` };
}

/**
 * Grow / shrink the masked (white) region by `radius` pixels.
 *
 * WARNING, measured — do not "simplify" these back to sharp's own names:
 * `sharp.dilate()` SHRINKS the white region and `sharp.erode()` GROWS it, the
 * opposite of both the standard convention and sharp's own doc comment
 * ("Expand foreground objects using the dilate morphological operator").
 * libvips treats BLACK as foreground here.
 *
 * Measured on a true 1-band image, 4x4 white square (16px) on black:
 *   dilate(1) -> 4px   (white shrank)
 *   erode(1)  -> 36px  (white grew)
 *
 * Cost of trusting the name: `cleanMask` looked like close-then-open while
 * actually performing open-then-close, so it deleted thin structure and never
 * filled a single pinhole — and every mask still came out "clean enough" to pass
 * a glance. Named for the effect on the MASK, so call sites read correctly.
 */
async function growWhite(png: Buffer, radius: number): Promise<Buffer> {
  return sharp(png).erode(radius).toBuffer();
}

async function shrinkWhite(png: Buffer, radius: number): Promise<Buffer> {
  return sharp(png).dilate(radius).toBuffer();
}

/**
 * Morphological cleanup: close pinholes, then remove speckle.
 *
 * Order matters. Close (grow then shrink) fills the gaps a segmenter leaves
 * around grout and reflections; open (shrink then grow) then drops isolated
 * flecks. The reverse order deletes thin real structure before it has a chance
 * to be joined up.
 */
export async function cleanMask(mask: Mask, radius = 3): Promise<Mask> {
  const png = await encodeMask(mask);
  const closed = await shrinkWhite(await growWhite(png, radius), radius);
  const opened = await growWhite(await shrinkWhite(closed, radius), radius);
  return decodeMask(opened);
}

/** Grow the mask by `radius` px. Used to build trimap bands (Phase 6g). */
export async function dilateMask(mask: Mask, radius: number): Promise<Mask> {
  return decodeMask(await growWhite(await encodeMask(mask), radius));
}

/** Shrink the mask by `radius` px, so an alpha ramp sits inside the true surface. */
export async function erodeMask(mask: Mask, radius: number): Promise<Mask> {
  return decodeMask(await shrinkWhite(await encodeMask(mask), radius));
}

/** Keep only the largest connected component. */
export function largestComponent(mask: Mask): Mask {
  const { data, width, height } = mask;
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (!data[start] || labels[start] !== -1) continue;
    const id = sizes.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    let size = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      size++;
      // 4-connectivity. Written out rather than looped over an offset array: the
      // bounds test differs per direction (x for horizontal, y for vertical), and
      // this is the innermost loop of the whole mask pipeline.
      const push = (q: number) => {
        if (data[q] && labels[q] === -1) {
          labels[q] = id;
          stack[sp++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x + 1 < width) push(p + 1);
      if (y > 0) push(p - width);
      if (y + 1 < height) push(p + width);
    }
    sizes.push(size);
  }

  if (sizes.length === 0) return mask;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = labels[i] === best ? 255 : 0;
  return { data: out, width, height };
}

/** Pixelwise union. For "cupboards" arriving as N separate doors. */
export function union(masks: Mask[]): Mask {
  if (masks.length === 0) throw new Error("union: no masks");
  const { width, height } = masks[0];
  const out = new Uint8Array(width * height);
  for (const m of masks) {
    if (m.width !== width || m.height !== height) {
      throw new Error(`union: size mismatch ${m.width}x${m.height} vs ${width}x${height}`);
    }
    for (let i = 0; i < out.length; i++) if (m.data[i]) out[i] = 255;
  }
  return { data: out, width, height };
}

/** `a AND NOT b` — how furniture is cut out of a floor (Phase 6f occlusion). */
export function subtract(a: Mask, b: Mask): Mask {
  if (a.width !== b.width || a.height !== b.height) throw new Error("subtract: size mismatch");
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] && !b.data[i] ? 255 : 0;
  return { data: out, width: a.width, height: a.height };
}

/** Intersection over union — for comparing two candidate masks of one surface. */
export function iou(a: Mask, b: Mask): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("iou: size mismatch");
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i] !== 0;
    const y = b.data[i] !== 0;
    if (x || y) uni++;
    if (x && y) inter++;
  }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Encode as a single-band greyscale PNG.
 *
 * `toColourspace("b-w")` is load-bearing: without it sharp promotes the buffer to
 * 3-channel sRGB, which triples mask storage and — worse — makes morphology
 * behave differently than on a true 1-band image, so a fix verified on greyscale
 * would not hold in the pipeline.
 */
export async function encodeMask(mask: Mask): Promise<Buffer> {
  return sharp(Buffer.from(mask.data), {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Tint a mask over the photo so a human can check alignment.
 *
 * The one thing the numbers cannot tell you is whether the mask is on the right
 * OBJECT — a wall mask and a floor mask of the same size score identically.
 */
export async function overlay(photo: Buffer, mask: Mask, rgb: [number, number, number]): Promise<Buffer> {
  const { width, height } = await sharp(photo).metadata();
  if (!width || !height) throw new Error("overlay: photo has no dimensions");

  const scaled =
    mask.width === width && mask.height === height
      ? mask
      : await resizeMask(mask, width, height);

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < scaled.data.length; i++) {
    if (!scaled.data[i]) continue;
    const p = i * 4;
    rgba[p] = rgb[0];
    rgba[p + 1] = rgb[1];
    rgba[p + 2] = rgb[2];
    rgba[p + 3] = 110;
  }

  return sharp(photo)
    .composite([{ input: rgba, raw: { width, height, channels: 4 }, blend: "over" }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** Nearest-neighbour resize; a mask must stay binary, so no interpolation. */
export async function resizeMask(mask: Mask, width: number, height: number): Promise<Mask> {
  const png = await encodeMask(mask);
  const out = await sharp(png)
    .resize(width, height, { kernel: "nearest", fit: "fill" })
    .toBuffer();
  return decodeMask(out);
}
