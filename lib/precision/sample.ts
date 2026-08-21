/**
 * Anisotropic texture sampling over a mip pyramid.
 *
 * NO IMPORTS. Runs in the warp worker and mirrors what `EXT_texture_filter_anisotropic`
 * does for the WebGL preview, so the preview and the final render show the same
 * grout lines rather than the same layout with different noise.
 *
 * THE PROBLEM THIS SOLVES. Project a 600mm tile onto a floor photographed from
 * standing height and, three metres out, one screen pixel covers most of a tile —
 * elongated along the view direction, thin across it. Bilinear reads 4 texels from
 * that whole footprint, so which 4 depends on sub-pixel position, so grout lines
 * flicker in and out and the far field crawls. It is the single most recognisable
 * "this is CGI" artefact and no amount of relighting hides it.
 *
 * Trilinear over a mip pyramid fixes the flicker by pre-averaging, but a mip level
 * is isotropic: to cover the footprint's LONG axis it must blur by that much on
 * the short axis too, so the far field goes to mush and grout disappears. EWA
 * filtering is the correct answer; the cheap approximation that captures nearly
 * all of it is to pick the mip for the SHORT axis and take several taps along the
 * long one. That keeps the joint sharp across its width while averaging along its
 * length, which is exactly what the eye is reading.
 */

/** One mip level: RGB or RGBA, tightly packed, `width * height * channels`. */
export type MipLevel = {
  data: Uint8Array;
  width: number;
  height: number;
};

export type Pyramid = {
  levels: MipLevel[];
  channels: number;
};

export const MAX_TAPS = 16;

/**
 * Bilinear read at level `l`, WRAPPING on both axes.
 *
 * Wrap rather than clamp because the textures are seamless by construction (see
 * `lib/textures.ts`) and the tiler feeds uv in [0,1) per tile — clamping would
 * stretch the last row of texels along every tile edge, drawing a faint border on
 * each one that looks like bad grout.
 */
export function bilinear(
  level: MipLevel,
  channels: number,
  u: number,
  v: number,
  out: Float32Array,
): void {
  const { data, width, height } = level;
  // -0.5 puts the sample on texel CENTRES. Without it every mip level is offset by
  // half a texel from the one above, and the drift compounds down the pyramid into
  // a visible shift between near and far field.
  const fx = u * width - 0.5;
  const fy = v * height - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  const x0 = ((ix % width) + width) % width;
  const y0 = ((iy % height) + height) % height;
  const x1 = (x0 + 1) % width;
  const y1 = (y0 + 1) % height;

  const i00 = (y0 * width + x0) * channels;
  const i10 = (y0 * width + x1) * channels;
  const i01 = (y1 * width + x0) * channels;
  const i11 = (y1 * width + x1) * channels;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  for (let c = 0; c < channels; c++) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11;
  }
}

/** Trilinear: bilinear on two adjacent levels, blended by the LOD fraction. */
export function trilinear(
  pyr: Pyramid,
  u: number,
  v: number,
  lod: number,
  out: Float32Array,
  scratch: Float32Array,
): void {
  const top = pyr.levels.length - 1;
  const l = Math.min(Math.max(lod, 0), top);
  const l0 = Math.floor(l);
  const frac = l - l0;

  bilinear(pyr.levels[l0], pyr.channels, u, v, out);
  if (frac <= 0 || l0 >= top) return;

  bilinear(pyr.levels[l0 + 1], pyr.channels, u, v, scratch);
  for (let c = 0; c < pyr.channels; c++) out[c] += (scratch[c] - out[c]) * frac;
}

/**
 * Sampler state. Reused across every output pixel — allocating four Float32Arrays
 * per pixel would spend more time in the GC than in the filter.
 */
export type Sampler = {
  out: Float32Array;
  acc: Float32Array;
  tap: Float32Array;
  scratch: Float32Array;
};

export function makeSampler(channels: number): Sampler {
  return {
    out: new Float32Array(channels),
    acc: new Float32Array(channels),
    tap: new Float32Array(channels),
    scratch: new Float32Array(channels),
  };
}

/**
 * EWA-lite: N trilinear taps spread along the footprint's major axis.
 *
 * `major`/`minor` are the footprint's axis lengths in TEXELS of level 0, and
 * `dirU`/`dirV` the unit major-axis direction in uv. The caller gets those from
 * the homography's analytic Jacobian, so no finite differences and no guessing.
 *
 * Tap count is the anisotropy ratio, capped at 16 — the same cap the hardware
 * extension uses, and past it the extra taps are below the noise floor of the
 * texture itself. The cap is what bounds worst-case cost: a grazing floor is
 * 16 taps, not the 300 a true EWA would want.
 */
export function sampleAniso(
  pyr: Pyramid,
  u: number,
  v: number,
  major: number,
  minor: number,
  dirU: number,
  dirV: number,
  s: Sampler,
): Float32Array {
  const ch = pyr.channels;
  const lo = Math.max(minor, 1e-6);
  const taps = Math.min(MAX_TAPS, Math.max(1, Math.ceil(major / lo)));

  // LOD from the SHORT axis. Using the long axis here is the over-blur bug this
  // whole function exists to avoid; using the short axis alone (without the taps
  // below) is the shimmer bug. Both halves are load-bearing.
  const lod = Math.log2(lo);

  if (taps === 1) {
    trilinear(pyr, u, v, lod, s.out, s.scratch);
    return s.out;
  }

  s.acc.fill(0);
  // Step along the major axis in uv. `major` is in level-0 texels and dirU/dirV are
  // already normalized in uv, so the extent has to be converted back — the caller
  // passes dirU/dirV pre-scaled so that (dirU,dirV) * major is the half-extent.
  for (let t = 0; t < taps; t++) {
    // Symmetric about the centre, endpoints excluded, so the taps sample the
    // footprint's interior rather than piling two of them on its edges.
    const off = (t + 0.5) / taps - 0.5;
    trilinear(pyr, u + dirU * off, v + dirV * off, lod, s.tap, s.scratch);
    for (let c = 0; c < ch; c++) s.acc[c] += s.tap[c];
  }
  for (let c = 0; c < ch; c++) s.out[c] = s.acc[c] / taps;
  return s.out;
}

/**
 * Build a mip pyramid by successive 2x2 box reduction, down to 1x1.
 *
 * Box rather than Lanczos here, unlike the material ingest path in
 * `lib/textures.ts`. Deliberate: a box filter is exactly what a GPU's
 * `generateMipmap` does, and the point is for the server render to match the WebGL
 * preview. A sharper pyramid on the server would make the final render look
 * subtly crisper than the preview the user approved.
 *
 * Odd dimensions round DOWN and drop the last row/column, which is what the GL
 * spec's default does too.
 */
export function buildPyramid(base: MipLevel, channels: number): Pyramid {
  const levels: MipLevel[] = [base];
  let cur = base;
  while (cur.width > 1 || cur.height > 1) {
    const w = Math.max(1, cur.width >> 1);
    const h = Math.max(1, cur.height >> 1);
    const data = new Uint8Array(w * h * channels);
    const sx = cur.width > 1 ? 2 : 1;
    const sy = cur.height > 1 ? 2 : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * channels;
        for (let c = 0; c < channels; c++) {
          let sum = 0;
          for (let dy = 0; dy < sy; dy++) {
            for (let dx = 0; dx < sx; dx++) {
              sum += cur.data[((y * sy + dy) * cur.width + (x * sx + dx)) * channels + c];
            }
          }
          // +0.5 before the truncation: rounding down every level darkens the
          // pyramid monotonically, so the far field ends up measurably dimmer than
          // the near field for no reason anyone would ever think to look for.
          data[o + c] = (sum / (sx * sy) + 0.5) | 0;
        }
      }
    }
    cur = { data, width: w, height: h };
    levels.push(cur);
  }
  return { levels, channels };
}
