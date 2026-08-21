/**
 * Procedural placeholder textures.
 *
 * The 15 swatches in showroom/editor.html are CSS gradients — they are not
 * images and cannot be fed to a renderer. Until real supplier bitmaps arrive,
 * these generate *seamless* tile-face bitmaps at a known mm scale so the
 * Precision pipeline (homography -> mm tiling -> mip filtering) has something
 * truthful to project.
 *
 * Seamless matters: the tiler reads with wrap-around, so a non-tileable texture
 * shows a visible grid seam at every cell edge. Value noise on a torus (the
 * lattice index wraps modulo the grid) is seamless by construction.
 *
 * The texture is the TILE FACE only. Grout is drawn by the renderer from
 * `materials.grout_mm`, never baked in — baking it would lock the joint width
 * to whatever this script guessed.
 */
import sharp, { type OverlayOptions } from "sharp";

/** Deterministic 2D hash in [0,1). No Math.random — seeds must be reproducible. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Value noise on a torus of `gridX` x `gridY` cells — wraps on both axes, so
 * the result is tileable.
 *
 * The grid is deliberately allowed to be non-square. That is the ONLY correct
 * way to get directional grain here: scaling the input coordinate instead
 * (`valueNoise(u * 0.25, ...)`) makes the domain stop spanning [0,1), the
 * lattice no longer wraps at the texture edge, and you get a visible seam at
 * every tile boundary. Measured: a fractional multiplier produced a 1.5-3.4
 * mean-level edge discontinuity against ~0.0 for the interior.
 */
function valueNoise(x: number, y: number, gridX: number, gridY: number, seed: number): number {
  const fx = x * gridX;
  const fy = y * gridY;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = smooth(fx - ix);
  const ty = smooth(fy - iy);
  const mx = (n: number) => ((n % gridX) + gridX) % gridX;
  const my = (n: number) => ((n % gridY) + gridY) % gridY;
  const a = hash2(mx(ix), my(iy), seed);
  const b = hash2(mx(ix + 1), my(iy), seed);
  const c = hash2(mx(ix), my(iy + 1), seed);
  const d = hash2(mx(ix + 1), my(iy + 1), seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Octave sum. `gridX`/`gridY` set the base lattice; both double per octave. */
function fbm(
  x: number,
  y: number,
  seed: number,
  octaves: number,
  gridX: number,
  gridY: number,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const k = 2 ** o;
    sum += amp * valueNoise(x, y, gridX * k, gridY * k, seed + o * 101);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

export type TextureSpec = {
  /** Output pixel size. Square; the renderer handles non-square tiles via mm dims. */
  size: number;
  /** sRGB base colour. */
  base: [number, number, number];
  /** How far the grain modulates lightness, 0..1. */
  contrast: number;
  /**
   * `stone` = isotropic mottling. `wood` = grain stretched along x, so the
   * plank direction is visible and the anisotropic filter has something to
   * actually resolve. `concrete` = fine speckle over a broad wash.
   */
  grain: "stone" | "wood" | "concrete";
  seed: number;
};

/** Render a seamless tile face as a PNG buffer. */
export async function generateTexture(spec: TextureSpec): Promise<Buffer> {
  const { size, base, contrast, grain, seed } = spec;
  const px = Buffer.allocUnsafe(size * size * 3);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      let n: number;
      if (grain === "wood") {
        // Anisotropy via a wide, shallow lattice: broad rings running across
        // the plank (few cells in u, many in v) plus fine fibre along it.
        const rings = fbm(u, v, seed, 4, 1, 4);
        const fibre = fbm(u, v, seed + 77, 3, 2, 24);
        n = rings * 0.72 + fibre * 0.28;
      } else if (grain === "concrete") {
        const wash = fbm(u, v, seed, 3, 2, 2);
        const speckle = fbm(u, v, seed + 31, 2, 48, 48);
        n = wash * 0.65 + speckle * 0.35;
      } else {
        const body = fbm(u, v, seed, 5, 4, 4);
        // A second, sparser octave set reads as veining rather than fog.
        const vein = Math.abs(fbm(u, v, seed + 13, 3, 3, 3) - 0.5) * 2;
        n = body * 0.7 + (1 - vein) * 0.3;
      }

      // Centre the modulation on 1.0 so `base` stays the mean colour — the
      // seeded color_lab below has to remain true after the grain is applied.
      const k = 1 + (n - 0.5) * 2 * contrast;
      const o = (y * size + x) * 3;
      px[o] = Math.max(0, Math.min(255, Math.round(base[0] * k)));
      px[o + 1] = Math.max(0, Math.min(255, Math.round(base[1] * k)));
      px[o + 2] = Math.max(0, Math.min(255, Math.round(base[2] * k)));
    }
  }

  return sharp(px, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Build the mip pyramid. Lanczos3 down to 4px; the anisotropic sampler picks a
 * level from the homography's Jacobian, so missing small levels means shimmer
 * toward the vanishing point.
 *
 * Each level halves the previous one rather than resizing the base directly —
 * that's what makes the chain match what the GPU does in the WebGL preview,
 * so server and client renders agree.
 */
export async function buildMips(base: Buffer): Promise<Buffer[]> {
  const levels: Buffer[] = [base];
  let current = base;
  let { width } = await sharp(base).metadata();
  while (width && width > 4) {
    width = Math.max(4, Math.floor(width / 2));
    current = await sharp(current)
      .resize(width, width, { kernel: "lanczos3", fit: "fill" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    levels.push(current);
  }
  return levels;
}

/**
 * Sidebar preview: the tile laid out flat-on with real grout proportions, so
 * the swatch card communicates joint width and repeat — the two things a CSS
 * gradient can't. This is presentation only; the renderer never reads it.
 */
export async function generateHero(
  texture: Buffer,
  opts: { tileWMm: number; tileHMm: number; groutMm: number; size?: number },
): Promise<Buffer> {
  const size = opts.size ?? 480;
  // Show roughly 2.4 tile widths across, so the repeat is legible without the
  // tiles becoming unreadably small on a narrow sidebar card.
  const mmAcross = opts.tileWMm * 2.4;
  const pxPerMm = size / mmAcross;

  const tileW = Math.max(8, Math.round(opts.tileWMm * pxPerMm));
  const tileH = Math.max(8, Math.round(opts.tileHMm * pxPerMm));
  const grout = Math.max(1, Math.round(opts.groutMm * pxPerMm));

  const face = await sharp(texture).resize(tileW, tileH, { fit: "fill" }).toBuffer();

  const composites: OverlayOptions[] = [];
  const cellW = tileW + grout;
  const cellH = tileH + grout;
  for (let row = 0; row * cellH < size + cellH; row++) {
    for (let col = 0; col * cellW < size + cellW; col++) {
      composites.push({ input: face, left: col * cellW, top: row * cellH });
    }
  }

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      // Grout: a desaturated mid grey. Real grout reads darker than the tile
      // because the joint is recessed and self-shadows.
      background: { r: 150, g: 146, b: 138 },
    },
  })
    .composite(composites)
    .extract({ left: 0, top: 0, width: size, height: size })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

