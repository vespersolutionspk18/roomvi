/**
 * Render Precision mode against the real photo and its real floor mask.
 *
 * The unit suite proves the arithmetic. This proves the thing arithmetic cannot:
 * that the projection, the mask, the shading field and the composite all line up on
 * an actual photograph. The three failure modes it exists to catch are all VISUAL
 * and none of them throw:
 *
 *   shimmer  -> aliasing toward the vanishing point (the filter is wrong)
 *   halo     -> a bright rim along the skirting board (the matting is wrong)
 *   pasted   -> flat, unlit material (the shading transfer is wrong)
 *
 * So it writes files to look at, and asserts the numbers that must hold regardless:
 * bit-equality outside the mask, the tile count against a tape measure, and the
 * shading field's own statistics.
 *
 * Free. No fal, no diffusion — that is the whole point of this executor.
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import sharp from "sharp";
import { db, pool } from "../lib/db";
import { images, surfaces } from "../lib/db/schema";
import type { SurfacePlane } from "../lib/db/schema";
import { linearToSrgb, srgbToLinear } from "../lib/color";
import { decodeMask } from "../lib/mask";
import { renderPrecision } from "../lib/precision/execute";
import { isConvex, planeFromQuad, seedQuad } from "../lib/precision/homography";
import type { TileSpec } from "../lib/precision/tile";
import * as storage from "../lib/storage";
import { generateTexture } from "../lib/textures";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * Pearson correlation between two images' high-pass detail, inside a mask.
 *
 * High-pass = luma minus its own 3x3 box mean, which isolates exactly the scale a
 * grout joint lives at. Two unrelated tilings score near zero; a render still carrying
 * the original's joints scores strongly positive.
 */
async function detailCorrelation(
  a: Buffer,
  b: Buffer,
  mask: { data: Uint8Array; width: number; height: number },
): Promise<number> {
  const load = async (buf: Buffer) => {
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    const luma = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      luma[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
    }
    const hp = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += luma[(y + dy) * w + x + dx];
        hp[y * w + x] = luma[y * w + x] - s / 9;
      }
    }
    return hp;
  };
  const [ha, hb] = await Promise.all([load(a), load(b)]);

  // Skip a 2px band inside the mask edge: the feather ramp there is a genuine blend of
  // the two images and would register as correlation that has nothing to do with
  // ghosting in the interior.
  const { width: w, height: h } = mask;
  let n = 0;
  let sa = 0;
  let sb = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (!mask.data[i] || !mask.data[i - 2] || !mask.data[i + 2] || !mask.data[i - 2 * w] || !mask.data[i + 2 * w]) continue;
      n++;
      sa += ha[i];
      sb += hb[i];
    }
  }
  if (n < 100) return 0;
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (!mask.data[i] || !mask.data[i - 2] || !mask.data[i + 2] || !mask.data[i - 2 * w] || !mask.data[i + 2 * w]) continue;
      const da = ha[i] - ma;
      const dbv = hb[i] - mb;
      cov += da * dbv;
      va += da * da;
      vb += dbv * dbv;
    }
  }
  return va < 1e-9 || vb < 1e-9 ? 0 : cov / Math.sqrt(va * vb);
}

const OUT = "storage/precision-test";

/** Mean RGB, optionally restricted to a mask. */
async function meanRgb(buf: Buffer, mask?: { data: Uint8Array }): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    if (mask && !mask.data[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) s[c] += data[i * 3 + c];
  }
  const d = Math.max(1, n);
  return [s[0] / d, s[1] / d, s[2] / d];
}

async function main() {
  const img = await db.query.images.findFirst({
    where: isNotNull(images.analyzedAt),
    orderBy: [desc(images.analyzedAt)],
  });
  if (!img?.displayWidth || !img.displayHeight || !img.displayKey) {
    throw new Error("no analyzed image with a display copy");
  }

  const zones = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, img.id) });
  const floor = zones.find((z) => z.kind === "floor");
  if (!floor) throw new Error("no floor surface on the latest image");

  console.log(`\nprecision render — image ${img.id} (${img.displayWidth}x${img.displayHeight})\n`);

  /* ---------------------------------------------- the colour round trip */

  // Asserted here, before any pixel is rendered, because getting this wrong does not
  // throw and does not obviously look like a unit error. `srgbToLinear` takes 0..255
  // and `linearToSrgb` RETURNS 0..255; both were being called as if they were 0..1,
  // which put the LUT 255x too dark on the way in and overflowed the Uint8Array on
  // the way out. A Uint8Array wraps modulo 256 rather than clipping, so pale marble
  // rendered as blown white and mid-tone terracotta as saturated red — while every
  // geometric and statistical assertion in this file stayed green.
  check(`srgbToLinear(255) is 1.0 (got ${srgbToLinear(255).toFixed(4)})`, Math.abs(srgbToLinear(255) - 1) < 1e-6);
  check(`srgbToLinear(0) is 0.0`, srgbToLinear(0) === 0);
  check(`linearToSrgb(1.0) is 255 (got ${linearToSrgb(1)})`, linearToSrgb(1) === 255);
  {
    let worst = 0;
    for (let i = 0; i < 256; i++) worst = Math.max(worst, Math.abs(linearToSrgb(srgbToLinear(i)) - i));
    check(`sRGB -> linear -> sRGB round-trips exactly for all 256 levels (worst ${worst})`, worst === 0);
  }

  const photo = await storage.get(img.displayKey);
  const mask = await decodeMask(await storage.get(floor.maskKey));
  check(
    `the floor mask matches the display size (${mask.width}x${mask.height})`,
    mask.width === img.displayWidth && mask.height === img.displayHeight,
  );

  // Seed the quad from the mask's own bbox, which is what the UI will do before the
  // user drags it. If the auto-seed cannot produce a usable plane, the interaction
  // starts from a broken state and every user has to fix it by hand.
  const bbox = floor.bbox ?? [0.05, 0.5, 0.95, 0.99];
  const quad = seedQuad(bbox, mask.width, mask.height);
  check("the auto-seeded floor quad is convex", isConvex(quad));

  // 3600mm x 4200mm: a plausible kitchen floor. In the product the user states one
  // real dimension; here it is fixed so the tile count is checkable by hand.
  const REF_W = 3600;
  const REF_H = 4200;
  const solved = planeFromQuad(quad, REF_W, REF_H);
  check("the plane solves from the seeded quad", solved !== null);
  if (!solved) return;

  const plane: SurfacePlane = {
    quad: quad as SurfacePlane["quad"],
    refWidthMm: REF_W,
    refHeightMm: REF_H,
    H: solved.H,
    theta: 0,
  };

  await sharp(photo).toFile(`${OUT}/00-original.jpg`).catch(async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(OUT, { recursive: true });
    await sharp(photo).toFile(`${OUT}/00-original.jpg`);
  });

  /* ------------------------------------------------------ three materials */

  const cases: Array<{ name: string; tile: TileSpec; texture: Parameters<typeof generateTexture>[0] }> = [
    {
      // Large-format pale stone. The hardest case for shading transfer: replacing a
      // dark floor with a light one is exactly where "preserve L" fails.
      name: "01-marble-600",
      tile: { tileWMm: 600, tileHMm: 600, groutMm: 3, bond: "stack", theta: 0 },
      texture: { size: 512, base: [232, 228, 220], contrast: 0.1, grain: "stone", seed: 11 },
    },
    {
      // Wood plank, running bond. The anisotropic grain is what makes filtering
      // failures visible — a wrong LOD turns the grain to grey mush.
      name: "02-oak-plank-1200x200",
      tile: { tileWMm: 1200, tileHMm: 200, groutMm: 1, bond: "running", theta: 0 },
      texture: { size: 512, base: [156, 116, 74], contrast: 0.22, grain: "wood", seed: 23 },
    },
    {
      // Small tiles at 45 degrees: the densest joint pattern, so the worst case for
      // aliasing in the far field.
      name: "03-terracotta-200-diag",
      tile: { tileWMm: 200, tileHMm: 200, groutMm: 5, bond: "stack", theta: Math.PI / 4 },
      texture: { size: 384, base: [178, 104, 72], contrast: 0.18, grain: "concrete", seed: 37 },
    },
  ];

  for (const c of cases) {
    const texture = await generateTexture(c.texture);
    const t0 = Date.now();
    const result = await renderPrecision({
      photo,
      mask,
      texture,
      plane,
      tile: c.tile,
      grout: { rgb: [190, 186, 178] },
    });
    const ms = Date.now() - t0;

    const fs = await import("node:fs/promises");
    await fs.mkdir(OUT, { recursive: true });
    await fs.writeFile(`${OUT}/${c.name}.jpg`, result.output);

    const k = result.check;
    console.log(
      `\n  ${c.name} — ${ms}ms, ${k.maxTaps} max taps, ${(k.painted * 100).toFixed(1)}% painted, ${(k.changedInside * 100).toFixed(1)}% changed`,
    );

    // THE check. A pure composite must not alter a single pixel whose alpha is zero.
    check(`${c.name}: outside the mask is bit-identical`, k.outsideUntouched);

    // ITS PARTNER, and the reason this file grew an assertion. `outsideUntouched`
    // is vacuously true for a render that paints nothing, and that is precisely how
    // a 3-channel alpha buffer indexed as 1-channel passed 27 assertions while
    // producing output byte-identical to the input photo. Never assert the negative
    // alone.
    check(
      `${c.name}: the composited region actually changed (${(k.changedInside * 100).toFixed(1)}%)`,
      k.changedInside > 0.9,
    );

    check(
      `${c.name}: the plane round-trips to sub-pixel (${k.residualPx.toExponential(1)} px)`,
      k.residualPx < 1e-6,
    );

    // The product claim, measured. floor(3600/603)+1 = 6 across for the 600mm case.
    check(
      `${c.name}: ${k.tilesAcross} joints across matches arithmetic (${k.expectedAcross})`,
      k.tilesAcross === k.expectedAcross,
    );
    check(
      `${c.name}: ${k.tilesDown} joints down matches arithmetic (${k.expectedDown})`,
      k.tilesDown === k.expectedDown,
    );

    // The shading field must have real dynamic range. If p05 and p95 collapse to 1.0
    // the transfer is a no-op and the render will look pasted however good the
    // geometry is — a silent failure that no other check catches.
    check(
      `${c.name}: the shading field carries contrast (p05 ${k.shading.p05.toFixed(2)}, p95 ${k.shading.p95.toFixed(2)})`,
      k.shading.p95 / k.shading.p05 > 1.15,
    );
    check(
      `${c.name}: the ratio clamp is not swallowing the image (${k.shading.clampedPct.toFixed(1)}% clamped)`,
      k.shading.clampedPct < 40,
    );

    // Far-field anisotropy must actually be engaging. maxTaps == 1 everywhere means
    // the sampler degenerated to trilinear and the vanishing point will shimmer.
    check(`${c.name}: the anisotropic path engaged (${k.maxTaps} taps)`, k.maxTaps > 1);

    // COLOUR FIDELITY, the whole product claim: the projected material's hue must be
    // the material's hue.
    //
    // Measured on a GROUT-FREE, TINT-FREE variant, because the shipped render mixes in
    // two deliberate, correct contributions that both pull toward grey: the illuminant
    // tint at 45%, and the grout ramp, which widens to the footprint width — up to
    // 27mm around a 5mm joint in the far field, so grout legitimately dominates large
    // areas out there. Folding those into a hue check makes the threshold arbitrary
    // (terracotta drifts 14.5% honestly). Isolating the material tests one claim.
    //
    // Absolute lightness still differs on purpose — the room's shading is multiplied
    // in — so this compares CHROMA RATIOS (r/g, b/g), which uniform scaling leaves
    // invariant.
    const bare = await renderPrecision({
      photo,
      mask,
      texture,
      plane,
      tile: { ...c.tile, groutMm: 0 },
      relight: { tintStrength: 0 },
    });
    const texMean = await meanRgb(texture);
    const outMean = await meanRgb(bare.output, mask);
    const texRatio = [texMean[0] / texMean[1], texMean[2] / texMean[1]];
    const outRatio = [outMean[0] / outMean[1], outMean[2] / outMean[1]];
    const drift = Math.max(
      Math.abs(texRatio[0] - outRatio[0]) / texRatio[0],
      Math.abs(texRatio[1] - outRatio[1]) / texRatio[1],
    );
    console.log(
      `    texture [${texMean.map((v) => v.toFixed(0)).join(",")}] -> bare floor [${outMean.map((v) => v.toFixed(0)).join(",")}], chroma drift ${(drift * 100).toFixed(1)}%`,
    );
    check(`${c.name}: the projected material keeps its hue (${(drift * 100).toFixed(1)}% chroma drift)`, drift < 0.05);

    // GHOSTING. The old floor's grout lines must not be readable through the new
    // material. They are EDGES, and the shading filter is edge-preserving by design,
    // so without the thin-dark removal in `shadingField` they survive into the ratio
    // field and get multiplied onto whatever is projected — you can read the previous
    // floor's layout through a completely different tile.
    //
    // Measured as the correlation between the two images' high-pass detail inside the
    // mask. The new tiling has its own joints, which correlate with the old ones only
    // by coincidence, so a strong positive correlation means the old surface is still
    // showing. Compared against the SHIPPED render, since this is about what the user
    // sees.
    const ghost = await detailCorrelation(photo, result.output, mask);
    console.log(`    old-floor detail correlation ${ghost.toFixed(3)}`);
    check(`${c.name}: the old floor does not ghost through (r=${ghost.toFixed(3)})`, ghost < 0.3);
  }

  /* ------------------------------------------------- the pure-red probe */

  {
    // A texture that CANNOT be confused with the room. Every material above is a
    // plausible floor colour, which is exactly why three of them rendering as the
    // untouched original went unnoticed: pale marble on a pale stone floor looks
    // like pale stone. Saturated red on a bluish floor cannot.
    //
    // Kept permanently rather than deleted after the fix, because it is the only
    // assertion here that reads the OUTPUT PIXELS against a known expectation
    // instead of against the input. Two different materials once produced
    // byte-identical JPEGs and nothing in the suite objected.
    const red = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const probe = await renderPrecision({
      photo,
      mask,
      texture: red,
      plane,
      tile: { tileWMm: 600, tileHMm: 600, groutMm: 0, bond: "stack", theta: 0 },
      // No grout, no tint, full shading: the only thing that can reach the output is
      // the texture times the room's illumination.
      relight: { tintStrength: 0 },
    });
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${OUT}/05-red-probe.jpg`, probe.output);

    const orig = await sharp(photo).removeAlpha().raw().toBuffer();
    const got = await sharp(probe.output).removeAlpha().raw().toBuffer();
    let n = 0;
    let redder = 0;
    let sumRB = 0;
    for (let i = 0; i < mask.data.length; i++) {
      if (!mask.data[i]) continue;
      const o = i * 3;
      n++;
      sumRB += got[o] - got[o + 2];
      if (got[o] - got[o + 2] > orig[o] - orig[o + 2] + 40) redder++;
    }
    console.log(`\n  red probe — mean(R-B) ${(sumRB / Math.max(1, n)).toFixed(1)}, ${redder}/${n} decisively redder`);
    check(
      `the red probe turns the floor red (${((redder / Math.max(1, n)) * 100).toFixed(1)}% of masked px)`,
      redder / Math.max(1, n) > 0.85,
    );
    check(`the red probe's floor is red-dominant (mean R-B ${(sumRB / Math.max(1, n)).toFixed(1)})`, sumRB / Math.max(1, n) > 40);
  }

  /* --------------------------------------------------------- occlusion */

  {
    // Feed a synthetic occluder — a vertical bar across the floor, standing in for a
    // chair leg — and confirm those pixels are left as photo. The plane-depth tier
    // is not built yet; semantic subtraction is, and it is the one that matters for
    // furniture the segmenter did find.
    // Placed from the mask's OWN extent, not from a fraction of the frame. A floor
    // covering 3.6% of a photo sits wherever it sits; a bar at 45% of the width
    // missed it entirely on the first run, and "0/0 samples" is a test that passes
    // by testing nothing.
    let mnX = mask.width;
    let mxX = -1;
    let mnY = mask.height;
    let mxY = -1;
    for (let y = 0; y < mask.height; y++) {
      for (let x = 0; x < mask.width; x++) {
        if (!mask.data[y * mask.width + x]) continue;
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
        if (y > mxY) mxY = y;
      }
    }
    console.log(`
  floor mask spans x ${mnX}-${mxX}, y ${mnY}-${mxY}`);

    const bar = { width: mask.width, height: mask.height, data: new Uint8Array(mask.data.length) };
    const bx = Math.floor((mnX + mxX) / 2) - 20;
    for (let y = 0; y < mask.height; y++) {
      for (let x = bx; x < bx + 40; x++) bar.data[y * mask.width + x] = 255;
    }

    const texture = await generateTexture({ size: 512, base: [232, 228, 220], contrast: 0.1, grain: "stone", seed: 11 });
    const withOcc = await renderPrecision({
      photo,
      mask,
      texture,
      plane,
      tile: { tileWMm: 600, tileHMm: 600, groutMm: 3, bond: "stack", theta: 0 },
      occluders: [bar],
    });
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${OUT}/04-occluded.jpg`, withOcc.output);

    const noOcc = await renderPrecision({
      photo, mask, texture, plane,
      tile: { tileWMm: 600, tileHMm: 600, groutMm: 3, bond: "stack", theta: 0 },
    });

    check(
      `occlusion reduces the painted area (${(withOcc.check.painted * 100).toFixed(1)}% vs ${(noOcc.check.painted * 100).toFixed(1)}%)`,
      withOcc.check.painted < noOcc.check.painted - 0.02,
    );
    check("occlusion still leaves outside-mask bit-identical", withOcc.check.outsideUntouched);

    // The occluded column must read as the ORIGINAL photo, not as tile. Sampled at
    // the bar's centre, well inside it, so the feather ramp is not what is measured.
    const orig = await sharp(photo).removeAlpha().raw().toBuffer();
    const painted = await sharp(withOcc.output).removeAlpha().raw().toBuffer();
    let sameInBar = 0;
    let tested = 0;
    for (let y = mnY; y <= mxY; y += 2) {
      const x = bx + 20;
      const i = (y * mask.width + x) * 3;
      if (!mask.data[y * mask.width + x]) continue;
      tested++;
      // JPEG, so exact equality is not available — but an unpainted pixel must be
      // far closer to the original than a painted pale-marble one would be.
      if (Math.abs(orig[i] - painted[i]) < 12) sameInBar++;
    }
    check(
      `the occluded column reads as the original photo (${sameInBar}/${tested} samples)`,
      tested > 0 && sameInBar / tested > 0.85,
    );
  }

  console.log(`\n  wrote ${OUT}/`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => { console.error(`\n${err instanceof Error ? err.stack : err}\n`); process.exitCode = 1; })
  .finally(() => pool.end());
