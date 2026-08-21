/**
 * Browser-side mask handling for the zone overlay.
 *
 * Masks arrive as 1-bit grayscale PNGs from /api/files. Two things about them
 * decide the whole design of this module:
 *
 *  1. THE SIGNAL IS IN THE RED CHANNEL, NOT ALPHA. `encodeMask` writes a
 *     single-channel b-w PNG, so a canvas decodes it to opaque grey — every
 *     pixel has alpha 255 and the surface is where r == 255. Reading `data[i+3]`
 *     gives a solid rectangle, which looks like "the mask covers everything".
 *
 *  2. Masks are in DISPLAY pixel space, matching `images.display_width/height`.
 *     As long as the stage element keeps the image's aspect ratio, normalized
 *     coordinates map linearly and no letterboxing maths is needed.
 *
 * Tinted fills and outlines are built LAZILY and cached. Eagerly building two
 * RGBA canvases for seven 1MP masks is ~56MB of texture memory for overlays the
 * user may never hover.
 */

export type LoadedMask = {
  width: number;
  height: number;
  /** 0 or 255 per pixel, row-major. Used for hit testing. */
  bits: Uint8Array;
  /** How many pixels are on — lets a caller reject an empty decode. */
  count: number;
  /** Tinted solid fill, alpha = mask. Built on first call, then cached. */
  fill(): HTMLCanvasElement;
  /** 2px inner boundary of the mask, tinted. Built on first call. */
  edge(): HTMLCanvasElement;
};

/**
 * Decode one mask PNG into bits plus lazy tinted layers.
 *
 * `crossOrigin` is deliberately unset: /api/files is same-origin, and setting it
 * would make the request CORS-preflighted for no benefit.
 */
export async function loadMask(
  url: string,
  tint: [number, number, number],
): Promise<LoadedMask> {
  const img = new Image();
  img.decoding = "sync";
  img.src = url;
  await img.decode();

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("loadMask: no 2d context");
  sctx.drawImage(img, 0, 0);
  const src = sctx.getImageData(0, 0, w, h).data;

  const bits = new Uint8Array(w * h);
  let count = 0;
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    // Red channel, mid-point threshold. PNG decode is lossless, so this only
    // ever sees 0 or 255 in practice — the threshold guards against a mask that
    // was ever resampled on the way here.
    if (src[p] > 127) {
      bits[i] = 255;
      count++;
    }
  }

  let fillCache: HTMLCanvasElement | null = null;
  let edgeCache: HTMLCanvasElement | null = null;

  return {
    width: w,
    height: h,
    bits,
    count,
    fill() {
      if (!fillCache) fillCache = paint(bits, w, h, tint, false);
      return fillCache;
    },
    edge() {
      if (!edgeCache) edgeCache = paint(bits, w, h, tint, true);
      return edgeCache;
    },
  };
}

/**
 * Rasterize a tinted layer from the mask bits.
 *
 * `edgesOnly` keeps a pixel only if it sits on the mask boundary — any 4-neighbour
 * off, or the frame edge. That gives a crisp 1px inner outline, which is then
 * widened by drawing it twice at a 1px offset in `drawZone` rather than by
 * dilating here (cheaper, and keeps this function a single pass).
 */
function paint(
  bits: Uint8Array,
  w: number,
  h: number,
  tint: [number, number, number],
  edgesOnly: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("paint: no 2d context");

  const out = ctx.createImageData(w, h);
  const px = out.data;
  const [r, g, b] = tint;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!bits[i]) continue;

      if (edgesOnly) {
        const boundary =
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          !bits[i - 1] ||
          !bits[i + 1] ||
          !bits[i - w] ||
          !bits[i + w];
        if (!boundary) continue;
      }

      const p = i * 4;
      px[p] = r;
      px[p + 1] = g;
      px[p + 2] = b;
      px[p + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** Is this normalized point inside the mask? The click-to-select test. */
export function hitTest(mask: LoadedMask, nx: number, ny: number): boolean {
  if (nx < 0 || ny < 0 || nx >= 1 || ny >= 1) return false;
  const x = Math.floor(nx * mask.width);
  const y = Math.floor(ny * mask.height);
  return mask.bits[y * mask.width + x] === 255;
}

/**
 * Sample the mask on a small grid around a point.
 *
 * A raw single-pixel `hitTest` makes fragmented surfaces (a wall in 18 pieces)
 * feel broken to click — the cursor lands in a 1px gap between components and
 * nothing selects. Sampling a 3px-radius neighbourhood costs 9 reads and makes
 * the boundary forgiving without letting a click on the floor select the wall.
 */
export function hitTestSoft(mask: LoadedMask, nx: number, ny: number): boolean {
  const rx = 3 / mask.width;
  const ry = 3 / mask.height;
  for (const dy of [0, -ry, ry]) {
    for (const dx of [0, -rx, rx]) {
      if (hitTest(mask, nx + dx, ny + dy)) return true;
    }
  }
  return false;
}
