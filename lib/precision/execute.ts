/**
 * The Precision executor: project a real bitmap at true physical scale.
 *
 * NO DIFFUSION, NO FAL, NO COST. This is the differentiator — a generative render
 * gives you a floor that looks like the material; this gives you the material,
 * measured, with the room's own light on it. It also costs $0.00 per render against
 * $0.035-0.09, which is a margin argument as much as a quality one.
 *
 * WHY THE WARP IS HAND-WRITTEN. sharp cannot do perspective: `affine()` takes a
 * 2x2 matrix, which has no translation row and no projective row, and libvips'
 * `vips_mapim` is not exposed through the Node binding. node-canvas is worse —
 * Canvas2D's `transform()` is a 2x3 affine with a hardcoded [0,0,1] bottom row, so
 * perspective is not merely unavailable but unrepresentable. Verified in both
 * libraries' own type definitions before writing a line of this. So: an inverse
 * warp over a raw buffer, which is the honest amount of code for the job.
 *
 * INVERSE, not forward. Iterating the output and asking "what texture is here"
 * visits every output pixel exactly once and leaves no gaps; iterating the texture
 * and scattering forward leaves holes wherever the projection stretches, and
 * filling them is a worse problem than the one you started with.
 *
 * Planar surfaces only — floors, walls, countertops, backsplashes. A sofa is not a
 * plane and falls back to the generative path.
 */
import sharp from "sharp";
import type { SurfacePlane } from "@/lib/db/schema";
import { srgbToLinear } from "@/lib/color";
import type { Mask } from "@/lib/mask";
import { featherAlpha } from "@/lib/render/composite";
import { apply, footprint, invert, type Mat3 } from "./homography";
import { relight, shadingField, type RelightOptions } from "./relight";
import {
  buildPyramid,
  makeSampler,
  sampleAniso,
  type MipLevel,
  type Pyramid,
} from "./sample";
import { sampleTile, tileVariant, type TileSpec } from "./tile";

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i);

export type PrecisionInput = {
  /** The photo, at display resolution. */
  photo: Buffer;
  /** The surface mask, same dimensions as the photo. */
  mask: Mask;
  /** Seamless tile-face bitmap. */
  texture: Buffer;
  plane: SurfacePlane;
  tile: TileSpec;
  /** Masks of objects standing ON the surface — furniture, rugs, people. */
  occluders?: Mask[];
  grout?: { rgb: [number, number, number] };
  relight?: RelightOptions;
};

export type PrecisionResult = {
  /** JPEG. */
  output: Buffer;
  /** Everything the measurement overlay needs to make a verifiable claim. */
  check: {
    /** Worst corner round-trip residual, px. */
    residualPx: number;
    /** Tiles counted across the reference width and height. */
    tilesAcross: number;
    tilesDown: number;
    /** What the arithmetic says it should be. */
    expectedAcross: number;
    expectedDown: number;
    /** Fraction of surface pixels actually painted (occlusion reduces this). */
    painted: number;
    /** Bit-equality outside the mask. The check that catches the most real bugs. */
    outsideUntouched: boolean;
    /**
     * Fraction of composited pixels that actually differ from the photo.
     *
     * The necessary partner to `outsideUntouched`, which is VACUOUSLY TRUE when the
     * alpha is uniformly zero — a render that paints nothing touches nothing outside
     * the mask either. That exact failure passed a 27-assertion suite: the alpha came
     * back 3-channel and was indexed as 1-channel, so the composite never fired, and
     * every other number here is derived from the plane and the tiler rather than from
     * the output pixels. One of these two alone proves nothing.
     */
    changedInside: number;
    /** Max taps any pixel needed — how hard the far field was working. */
    maxTaps: number;
    shading: { median: number; p05: number; p95: number; clampedPct: number };
  };
};

/** Decode the texture to a level-0 mip and build the pyramid. */
async function loadTexture(texture: Buffer): Promise<Pyramid> {
  const { data, info } = await sharp(texture)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const base: MipLevel = {
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
  };
  return buildPyramid(base, 3);
}

/**
 * Project the material onto the surface.
 *
 * The loop is bounded by the mask's bbox rather than the frame, because a
 * backsplash covering 4% of a 2MP photo means 96% of the iterations would be a
 * mask test that fails.
 */
export async function renderPrecision(input: PrecisionInput): Promise<PrecisionResult> {
  const { mask, plane, tile } = input;
  const H: Mat3 = plane.H;
  const Hinv = invert(H);
  if (!Hinv) throw new Error("precision: the plane's homography is not invertible");

  const { data: photoRaw, info } = await sharp(input.photo)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  if (mask.width !== width || mask.height !== height) {
    throw new Error(
      `precision: mask is ${mask.width}x${mask.height} but the photo is ${width}x${height}`,
    );
  }
  const photo = new Uint8Array(photoRaw);

  const pyr = await loadTexture(input.texture);
  const texW = pyr.levels[0].width;
  const texH = pyr.levels[0].height;

  /* --------------------------------------------------------- occlusion */

  // Semantic subtraction: a chair standing on the floor is not floor, however
  // confidently the segmenter included it. Applied to a COPY so the caller's mask
  // and the shading field's mask stay the surface as detected.
  const paintable = new Uint8Array(mask.data);
  if (input.occluders?.length) {
    for (const occ of input.occluders) {
      if (occ.width !== width || occ.height !== height) continue;
      for (let i = 0; i < paintable.length; i++) if (occ.data[i]) paintable[i] = 0;
    }
  }

  /* ----------------------------------------------------------- shading */

  // From the mask as DETECTED, not the paintable one. The shading under a chair is
  // still the floor's shading, and excluding those pixels would bias the median
  // toward the lit areas and brighten everything.
  const field = shadingField(photo, width, height, mask, {});

  /* -------------------------------------------------------------- warp */

  // Linear-light RGB accumulator for the projected material, then relit in one
  // pass. Two buffers rather than one because relighting needs the tile value
  // before sRGB encoding, and encoding twice is both slower and lossy.
  const tileLinear = new Float32Array(width * height * 3);
  const painted = new Uint8Array(width * height);
  const sampler = makeSampler(3);
  const groutRgb = input.grout?.rgb ?? [186, 182, 174];
  const groutLin = [LIN[groutRgb[0]], LIN[groutRgb[1]], LIN[groutRgb[2]]];

  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!paintable[y * width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("precision: nothing to paint — the mask is empty after occlusion");

  let maxTaps = 1;
  let paintedCount = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (!paintable[i]) continue;

      // Pixel centre. Using the corner shifts the whole projection half a pixel,
      // which is invisible on its own and compounds with the mip centring offset.
      const world = apply(H, [x + 0.5, y + 0.5]);
      if (!world) continue;

      const fp = footprint(H, x + 0.5, y + 0.5);
      if (!fp) continue;

      // Soften the grout joint by the footprint width in mm, so a 3mm joint that is
      // a fifth of a pixel wide in the far field fades instead of aliasing into a
      // dotted line that crawls.
      const s = sampleTile(world[0], world[1], tile, fp.major * 0.5);

      const o = i * 3;
      if (s.grout >= 1) {
        tileLinear[o] = groutLin[0];
        tileLinear[o + 1] = groutLin[1];
        tileLinear[o + 2] = groutLin[2];
        painted[i] = 255;
        paintedCount++;
        continue;
      }

      const vr = tileVariant(s.row, s.col, s.u, s.v, 0.6, tile.tileWMm, tile.tileHMm);

      // Footprint in mm -> footprint in TEXELS. One tile face spans the whole
      // texture, so mm-per-texel is tileWMm/texW.
      const mmPerTexelX = tile.tileWMm / texW;
      const mmPerTexelY = tile.tileHMm / texH;
      const majorTexels = fp.major / Math.min(mmPerTexelX, mmPerTexelY);
      const minorTexels = fp.minor / Math.min(mmPerTexelX, mmPerTexelY);

      // Major-axis direction, in uv, pre-scaled so dir * offset walks the footprint.
      const extentU = fp.major / tile.tileWMm;
      const extentV = fp.major / tile.tileHMm;

      const taps = Math.min(16, Math.max(1, Math.ceil(majorTexels / Math.max(minorTexels, 1e-6))));
      if (taps > maxTaps) maxTaps = taps;

      const rgb = sampleAniso(
        pyr,
        vr.u,
        vr.v,
        majorTexels,
        minorTexels,
        extentU * 0.5,
        extentV * 0.5,
        sampler,
      );

      let r = LIN[rgb[0] | 0];
      let g = LIN[rgb[1] | 0];
      let b = LIN[rgb[2] | 0];

      if (s.grout > 0) {
        // Partial joint. Blend in linear light — blending in sRGB would make the
        // joint edge visibly lighter than either the tile or the grout.
        const t = s.grout;
        r += (groutLin[0] - r) * t;
        g += (groutLin[1] - g) * t;
        b += (groutLin[2] - b) * t;
      }

      tileLinear[o] = r;
      tileLinear[o + 1] = g;
      tileLinear[o + 2] = b;
      painted[i] = 255;
      paintedCount++;
    }
  }

  /* --------------------------------------------------------- relight */

  const relit = new Uint8Array(width * height * 4);
  relight(tileLinear, field, relit, input.relight ?? {});

  /* -------------------------------------------------------- composite */

  // Alpha from the PAINTED set, not the mask: an occluded pixel must be fully
  // transparent, and a soft ramp there would tint the chair leg with floor colour.
  //
  // Through `featherAlpha` rather than a local sharp chain, because two traps live
  // in that ~20 lines and this file got both wrong on the first pass: libvips'
  // morphology is inverted (`dilate` SHRINKS white), and a 1-band raw input comes
  // back from the morphology path as THREE interleaved channels. Indexing that as
  // 1-band reads the top third of the image smeared across every row — which for a
  // floor in the bottom quarter of the frame means alpha is zero everywhere, the
  // composite silently no-ops, and `outsideUntouched` then passes for the worst
  // possible reason. Measured: 34200 px in, 3ch/180000 bytes out.
  const alpha = await featherAlpha({ data: painted, width, height }, 2);

  const out = new Uint8Array(photo);
  for (let i = 0; i < width * height; i++) {
    const a = alpha[i] / 255;
    if (a <= 0) continue;
    const o = i * 3;
    const q = i * 4;
    if (a >= 1) {
      out[o] = relit[q];
      out[o + 1] = relit[q + 1];
      out[o + 2] = relit[q + 2];
      continue;
    }
    out[o] += (relit[q] - out[o]) * a;
    out[o + 1] += (relit[q + 1] - out[o + 1]) * a;
    out[o + 2] += (relit[q + 2] - out[o + 2]) * a;
  }

  /* ------------------------------------------------------------ verify */

  // Bit-equality outside the mask, on the RAW buffer before any encode. Worth more
  // than any perceptual metric: it catches a stray global `normalise()`, a
  // colourspace round trip, an off-by-one in the bbox loop — in microseconds. A
  // pure composite has no excuse for touching a pixel whose alpha is zero.
  let outsideUntouched = true;
  let insideTotal = 0;
  let insideChanged = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    const differs =
      out[o] !== photo[o] || out[o + 1] !== photo[o + 1] || out[o + 2] !== photo[o + 2];
    if (alpha[i] === 0) {
      if (differs) outsideUntouched = false;
      continue;
    }
    insideTotal++;
    if (differs) insideChanged++;
  }

  const check = {
    residualPx: residual(H, plane),
    ...countTiles(plane, tile),
    painted: paintedCount / Math.max(1, countOn(mask.data)),
    outsideUntouched,
    changedInside: insideChanged / Math.max(1, insideTotal),
    maxTaps,
    shading: field.stats,
  };

  const output = await sharp(Buffer.from(out), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return { output, check };
}

function countOn(bits: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) n++;
  return n;
}

/** Worst corner round-trip, px. The user-facing "measurement check" number. */
function residual(H: Mat3, plane: SurfacePlane): number {
  const Hinv = invert(H);
  if (!Hinv) return Infinity;
  const world: Array<[number, number]> = [
    [0, 0],
    [plane.refWidthMm, 0],
    [plane.refWidthMm, plane.refHeightMm],
    [0, plane.refHeightMm],
  ];
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const back = apply(Hinv, world[k]);
    if (!back) return Infinity;
    worst = Math.max(worst, Math.hypot(back[0] - plane.quad[k][0], back[1] - plane.quad[k][1]));
  }
  return worst;
}

/**
 * Count tile pitches across the reference rectangle, and what arithmetic expects.
 *
 * This is the claim the product makes out loud, so it is measured rather than
 * asserted: walk the reference span in world mm, count joint crossings, and compare
 * against refWidth / (tile + grout). A mismatch means the tiling and the plane
 * disagree, which no visual inspection would reliably catch.
 */
function countTiles(
  plane: SurfacePlane,
  tile: TileSpec,
): { tilesAcross: number; tilesDown: number; expectedAcross: number; expectedDown: number } {
  // The walk runs ALONG THE COURSES, not along the world axes. With theta = 45 a
  // world-x traverse crosses both joint families at 1/cos(45) the rate, so counting
  // on the world axis would report 13 joints where the tiler laid 18 — the tiling
  // would be right and the measurement check would call it wrong.
  const cos = Math.cos(tile.theta);
  const sin = Math.sin(tile.theta);

  const walk = (along: "x" | "y", span: number): number => {
    // Offset the traverse to a QUARTER pitch off the datum, not the centre of a
    // course. Two distinct failures forced this:
    //
    //   at 1mm     -> inside the joint itself for any grout wider than 2mm, so every
    //                 sample reads as grout and the count collapses to 1
    //   at 1/2     -> correct for stack, but running bond shifts alternate courses
    //                 by exactly half a cell, which lands a half-pitch probe in a
    //                 vertical joint on every offset course. The probe then never
    //                 leaves the grout, so consecutive courses read as one crossing
    //                 and a 21-joint floor counts 11.
    //
    // A quarter pitch is mid-face under BOTH alignments — 0.25 of a cell on even
    // courses, 0.75 on odd — which is the only offset that survives a bond shift.
    const offX = (tile.tileHMm + tile.groutMm) / 4;
    const offY = (tile.tileWMm + tile.groutMm) / 4;

    let crossings = 0;
    let prev = false;
    const step = Math.max(0.25, span / 20000);
    for (let d = 0; d <= span; d += step) {
      // Course-aligned basis: +u along the courses, +v across them.
      const [lx, ly] = along === "x" ? [d, offX] : [offY, d];
      const x = lx * cos - ly * sin;
      const y = lx * sin + ly * cos;
      const s = sampleTile(x, y, tile, 0);
      const g = s.grout > 0.5;
      if (g && !prev) crossings++;
      prev = g;
    }
    return crossings;
  };
  const pitchW = tile.tileWMm + tile.groutMm;
  const pitchH = tile.tileHMm + tile.groutMm;
  return {
    tilesAcross: walk("x", plane.refWidthMm),
    tilesDown: walk("y", plane.refHeightMm),
    // +1 because the course is anchored at the datum, so world 0 is itself a joint.
    expectedAcross: Math.floor(plane.refWidthMm / pitchW) + 1,
    expectedDown: Math.floor(plane.refHeightMm / pitchH) + 1,
  };
}
