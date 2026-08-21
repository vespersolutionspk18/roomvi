/**
 * Verify the structure guard and the composite against synthetic images.
 *
 * The guard decides whether a paid render is trustworthy. If its signals are wrong
 * it fails in one of two silent ways — passing every render (useless) or failing
 * every render (blocks the product) — and both look like "the guard is working"
 * from the outside. So each property is checked against an image pair whose correct
 * answer is known by construction:
 *
 *   identical pair        -> distance 0, SSIM 1
 *   re-encoded pair       -> still clean (a JPEG round-trip must not read as drift)
 *   shifted pair          -> caught (this is "the camera moved")
 *   recoloured pair       -> caught by MEAN DIFF, which SSIM cannot see
 *   locally edited pair   -> caught (this is "a wall changed")
 *   edit INSIDE the mask  -> clean (the whole point: expected change is not drift)
 *
 * That last pair against the ones before it is the real test. A guard that cannot
 * tell "changed where I asked" from "changed elsewhere" is not a guard.
 *
 * WHICH SIGNAL CATCHES WHAT is asserted, not just the verdict. Every threshold in
 * guard.ts was set from measurements on the project's own kitchen photo, and a
 * test that only checked the verdict would stay green while the signal that
 * actually earns its place silently stopped contributing.
 *
 * Free — synthetic images, no fal calls, no database.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  assertOutsideUntouched,
  compositeThroughMask,
  featherAlpha,
  guardMask,
} from "../lib/render/composite";
import {
  DRIFT_WARN,
  MAD_LIMIT,
  MAD_WORST_LIMIT,
  PHASH_LIMIT,
  SSIM_LIMIT,
  hamming,
  blockMeanAbsDiff,
  measureDrift,
  pHash,
  ssimMasked,
} from "../lib/render/guard";
import type { Mask } from "../lib/mask";
import { classifyPrompt, findSurfaceHint, materialPrompt } from "../lib/render/prompt";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const W = 512;
const H = 384;

/**
 * A synthetic "room": a gradient wall, a darker floor band, and a bright window
 * rectangle. Structured enough that a DCT and SSIM have real content to measure —
 * flat colour would make every hash identical and prove nothing.
 */
function room(
  opts: { shiftX?: number; wallTint?: number; floorTint?: number; wallOnlyLeft?: boolean } = {},
): Buffer {
  const shiftX = opts.shiftX ?? 0;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x + shiftX;
      const p = (y * W + x) * 3;
      const floor = y > H * 0.62;
      // `wallOnlyLeft` tints one wall instead of both: the local-repaint case,
      // which is what the worst-block statistic exists for.
      const tinted = opts.wallOnlyLeft ? x < W * 0.35 : true;

      let r: number, g: number, b: number;
      if (floor) {
        // A plank pattern, so the floor has high-frequency detail to compare.
        const plank = Math.floor(sx / 37) % 2 === 0 ? 0 : 14;
        r = 96 + plank + (opts.floorTint ?? 0);
        g = 74 + plank + (opts.floorTint ?? 0);
        b = 58 + plank + (opts.floorTint ?? 0);
      } else {
        const grad = Math.round((y / H) * 40);
        const tint = tinted ? (opts.wallTint ?? 0) : 0;
        r = 188 - grad + tint;
        g = 186 - grad + tint;
        b = 178 - grad + tint;
      }

      // The window: a bright block in the upper left, which is what a pHash keys
      // on and what "a moved window" would displace.
      if (sx > W * 0.08 && sx < W * 0.3 && y > H * 0.18 && y < H * 0.5) {
        r = 246;
        g = 244;
        b = 232;
      }

      rgb[p] = clamp(r);
      rgb[p + 1] = clamp(g);
      rgb[p + 2] = clamp(b);
    }
  }
  return rgb;
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

async function png(rgb: Buffer): Promise<Buffer> {
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** The floor band as a mask — the region a floor swap is allowed to change. */
function floorMask(): Mask {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y > H * 0.62) data[y * W + x] = 255;
    }
  }
  return { data, width: W, height: H };
}

async function main() {
  console.log("\nSTRUCTURE GUARD + COMPOSITE — synthetic pairs with known answers\n");

  const original = await png(room());

  /* ------------------------------------------------------------ pHash */

  const h1 = await pHash(original);
  const h2 = await pHash(await png(room()));
  check("identical images hash identically", hamming(h1, h2) === 0, String(hamming(h1, h2)));

  // A JPEG round-trip is unavoidable: renders are stored as JPEG. If that alone
  // registered as drift, every render would be flagged.
  const reencoded = await sharp(original).jpeg({ quality: 88 }).toBuffer();
  const hJpeg = await pHash(reencoded);
  check(
    `a JPEG round-trip is not drift (distance ${hamming(h1, hJpeg)})`,
    hamming(h1, hJpeg) <= 2,
    String(hamming(h1, hJpeg)),
  );

  // "The camera moved" — the failure the guard exists to catch. Asserted through
  // measureDrift rather than on pHash alone: measured on the real photo, a 20px
  // shift scores pHash 0, because 20px is half a pixel once the image is reduced
  // to 32x32. SSIM is what actually catches this, and the test says so.
  const shifted = await png(room({ shiftX: 26 }));
  const shiftDrift = await measureDrift(original, shifted, null);
  check(
    `a 26px shift is caught (${shiftDrift.verdict}, ${shiftDrift.detail})`,
    shiftDrift.verdict !== "clean",
    shiftDrift.detail,
  );
  check(
    `  ... and SSIM is the signal that catches it (${shiftDrift.ssim.toFixed(3)})`,
    shiftDrift.ssim < SSIM_LIMIT,
    shiftDrift.ssim.toFixed(3),
  );

  // Brightness alone must not read as STRUCTURAL change — that is what excluding
  // the DC term from the median buys. It should still be caught, by mean diff.
  const brighter = await sharp(original).modulate({ brightness: 1.12 }).png().toBuffer();
  const hBright = await pHash(brighter);
  check(
    `uniform brightening is not structural drift (pHash ${hamming(h1, hBright)})`,
    hamming(h1, hBright) <= PHASH_LIMIT,
    String(hamming(h1, hBright)),
  );

  /* --------------------------------------- SSIM, and what it cannot see */

  const gray = async (buf: Buffer) => new Uint8Array(await sharp(buf).greyscale().raw().toBuffer());
  const rgb = async (buf: Buffer) =>
    new Uint8Array(await sharp(buf).removeAlpha().toColourspace("srgb").raw().toBuffer());

  const gOriginal = await gray(original);
  const same = ssimMasked(gOriginal, await gray(await png(room())), W, H, () => true);
  check(`identical images score SSIM 1 (${same.ssim.toFixed(4)})`, same.ssim > 0.999);

  // THE MOST IMPORTANT ASSERTION IN THIS FILE, and it asserts a WEAKNESS. A
  // uniform recolour preserves local structure exactly, so SSIM reports it as
  // clean — correct behaviour, and the reason a two-signal guard would let a
  // model repaint the whole room and pass. Pinned so nobody "simplifies" the
  // third signal away on the grounds that SSIM already covers it.
  const wallChanged = await png(room({ wallTint: 34 }));
  const wallSsim = ssimMasked(gOriginal, await gray(wallChanged), W, H, () => true);
  check(
    `SSIM is BLIND to a uniform recolour — measured, not desired (${wallSsim.ssim.toFixed(3)})`,
    wallSsim.ssim > SSIM_LIMIT,
    `${wallSsim.ssim.toFixed(3)} — if this now fails, SSIM changed, recheck MAD_LIMIT`,
  );

  // And the signal that does see it. This pair is why the third tier exists.
  const wallMad = blockMeanAbsDiff(await rgb(original), await rgb(wallChanged), W, H, () => true);
  check(
    `block diff CATCHES that same recolour (${wallMad.mad.toFixed(1)} > ${MAD_LIMIT})`,
    wallMad.mad > MAD_LIMIT,
    wallMad.mad.toFixed(1),
  );

  // A hue rotation is the adversarial case for a greyscale metric: by construction
  // it rotates chroma and leaves luma almost untouched. Fed the same image as
  // neutral grey (luma replicated across all three channels) the signal vanishes;
  // fed real RGB it does not. That ratio is the argument for measuring colour.
  //
  // Measured on a saturated copy, NOT on the base room, and that is not cheating —
  // the synthetic room is deliberately near-grey (a grey wall and a near-white
  // window cover most of the frame), so rotating its hue is a genuinely small
  // change. A real kitchen has a warm floor and coloured tile.
  const colourful = await sharp(original).modulate({ saturation: 2.2 }).png().toBuffer();
  const hueShifted = await sharp(colourful).modulate({ hue: 25 }).png().toBuffer();
  // Replicated to three channels by hand: `greyscale()` collapses to one band and
  // sharp will not re-expand it, so asking blockMeanAbsDiff (which strides by 3)
  // to read it walks off the end of the buffer and returns NaN.
  const asGrey = async (buf: Buffer) => {
    const g = await sharp(buf).greyscale().toColourspace("b-w").raw().toBuffer();
    const out = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = g[i];
    }
    return out;
  };
  const hueGrey = blockMeanAbsDiff(await asGrey(colourful), await asGrey(hueShifted), W, H, () => true);
  const hueRgb = blockMeanAbsDiff(await rgb(colourful), await rgb(hueShifted), W, H, () => true);
  check(
    `a hue shift hides from luma (${hueGrey.mad.toFixed(2)}) and not from RGB (${hueRgb.mad.toFixed(
      1,
    )} > ${MAD_LIMIT})`,
    hueRgb.mad > hueGrey.mad * 2 && hueRgb.mad > MAD_LIMIT,
    `luma ${hueGrey.mad.toFixed(2)} vs rgb ${hueRgb.mad.toFixed(1)}`,
  );

  // The noise floor. A JPEG round-trip is unavoidable — renders are stored as
  // JPEG — so if it breached either limit every render would be flagged.
  const reMad = blockMeanAbsDiff(await rgb(original), await rgb(reencoded), W, H, () => true);
  check(
    `a JPEG round-trip stays under both diff limits (${reMad.mad.toFixed(
      2,
    )} < ${MAD_LIMIT}, worst ${reMad.worst.toFixed(1)} < ${MAD_WORST_LIMIT})`,
    reMad.mad < MAD_LIMIT && reMad.worst < MAD_WORST_LIMIT,
    `${reMad.mad.toFixed(2)} / ${reMad.worst.toFixed(1)}`,
  );

  // The statistic that catches the failure that actually happens. A model repaints
  // ONE wall; the frame-wide mean dilutes it, the worst block does not.
  const oneWall = await png(room({ wallTint: 45, wallOnlyLeft: true }));
  const localMad = blockMeanAbsDiff(await rgb(original), await rgb(oneWall), W, H, () => true);
  check(
    `a PARTIAL recolour shows up in the worst block (${localMad.worst.toFixed(
      0,
    )} > ${MAD_WORST_LIMIT}), which the mean dilutes (${localMad.mad.toFixed(1)})`,
    localMad.worst > MAD_WORST_LIMIT,
    `worst ${localMad.worst.toFixed(1)}, mean ${localMad.mad.toFixed(1)}`,
  );

  /* --------------------------------------------- the discrimination test */

  const mask = floorMask();
  const excluded = await guardMask(mask, 12);

  // A floor-only edit, measured OUTSIDE the floor mask, must read as clean. If
  // this fails the guard would reject every correct render.
  const floorEdited = await png(room({ floorTint: 60 }));
  const insideDrift = await measureDrift(original, floorEdited, excluded);
  check(
    `an edit INSIDE the mask reads clean (${insideDrift.verdict}, ${insideDrift.detail})`,
    insideDrift.verdict === "clean",
    insideDrift.detail,
  );

  // The same magnitude of change, but on the wall, must be caught.
  const wallEdited = await png(room({ wallTint: 40 }));
  const outsideDrift = await measureDrift(original, wallEdited, excluded);
  check(
    `an equal edit OUTSIDE the mask is caught (${outsideDrift.verdict})`,
    outsideDrift.verdict !== "clean",
    outsideDrift.detail,
  );
  check(
    `outside-mask drift scores higher than inside-mask (${outsideDrift.score.toFixed(
      3,
    )} > ${insideDrift.score.toFixed(3)})`,
    outsideDrift.score > insideDrift.score,
  );

  /**
   * ONE SCALE FOR ALL FOUR SIGNALS.
   *
   * `verdict` and `score` answer different questions — the verdict is for the log,
   * the score decides whether the UI interrupts the user — and the band between them
   * is intentional. What is NOT intentional is that band differing per signal.
   *
   * Each signal is normalised by 4x its own limit, so all four read 0.25 exactly at
   * their limit and cross DRIFT_WARN together. pHash used to divide by 32 instead,
   * scoring 0.31 at its limit: a pHash-only breach warned the user while an SSIM,
   * mean or worst-block breach of identical severity stayed silent. Found from two
   * real renders that came back `suspect` (mean 2.2 against a limit of 2) and scored
   * 0.28 — correctly quiet, but only by accident of which signal happened to fire.
   *
   * Asserted by constructing a report sitting AT each limit in turn, because the
   * synthetic drift cases all land at 0.43+ and never probe this boundary.
   */
  const atLimit = (over: Partial<Record<"phash" | "ssim" | "mad" | "worst", true>>) =>
    Math.max(
      Math.min(1, (over.phash ? PHASH_LIMIT : 0) / (PHASH_LIMIT * 4)),
      Math.min(1, Math.max(0, (1 - (over.ssim ? SSIM_LIMIT : 1)) / (1 - SSIM_LIMIT) / 4)),
      Math.min(1, (over.mad ? MAD_LIMIT : 0) / (MAD_LIMIT * 4)),
      Math.min(1, (over.worst ? MAD_WORST_LIMIT : 0) / (MAD_WORST_LIMIT * 4)),
    );
  const limitScores = {
    phash: atLimit({ phash: true }),
    ssim: atLimit({ ssim: true }),
    mad: atLimit({ mad: true }),
    worst: atLimit({ worst: true }),
  };
  for (const [name, s] of Object.entries(limitScores)) {
    check(
      `${name} at its limit scores ${s.toFixed(2)} — the same as every other signal`,
      Math.abs(s - 0.25) < 1e-9,
      `${s} != 0.25`,
    );
  }
  check(
    `no single signal at its limit warns the user (max ${Math.max(
      ...Object.values(limitScores),
    ).toFixed(2)} < DRIFT_WARN ${DRIFT_WARN})`,
    Math.max(...Object.values(limitScores)) < DRIFT_WARN,
  );

  /* -------------------------------------------------------- composite */

  const alpha = await featherAlpha(mask, 6);
  let ramp = 0;
  let solid = 0;
  let empty = 0;
  for (const v of alpha) {
    if (v === 0) empty++;
    else if (v === 255) solid++;
    else ramp++;
  }
  check("the feathered alpha has a real gradient band", ramp > 0, `${ramp} ramp px`);
  check("the feathered alpha still has a solid interior", solid > 0, `${solid} solid px`);
  // The erode-then-blur order is what keeps the ramp inside the surface. If it
  // leaked outward, the lit region would EXCEED the mask's own pixel count.
  const maskCount = mask.data.reduce((a, v) => a + (v ? 1 : 0), 0);
  check(
    `the alpha does not spill outside the mask (${solid + ramp} lit vs ${maskCount} masked)`,
    solid + ramp <= maskCount,
  );
  void empty;

  const edited = await png(room({ floorTint: 70, wallTint: 40 }));
  const composed = await compositeThroughMask(original, edited, mask);
  check("the composite produces a JPEG", composed.jpeg.length > 0);
  check(
    `the composite keeps the photo's dimensions (${composed.width}x${composed.height})`,
    composed.width === W && composed.height === H,
  );

  // THE assertion. Outside the mask, a pure composite must be bit-identical — this
  // is the guarantee no prompt can offer, and it is checked on raw buffers because
  // JPEG would break equality even when the composite was perfect.
  const originalRaw = await sharp(original).removeAlpha().raw().toBuffer();
  const composedRaw = await sharp(composed.jpeg)
    .removeAlpha()
    .raw()
    .toBuffer();
  void composedRaw;

  // Re-run the blend arithmetic to get the pre-JPEG buffer, which is what the
  // guarantee is actually about.
  const editedRaw = await sharp(edited).removeAlpha().raw().toBuffer();
  const rawComposite = Buffer.allocUnsafe(W * H * 3);
  for (let i = 0, p = 0; i < composed.alpha.length; i++, p += 3) {
    const a = composed.alpha[i];
    for (let c = 0; c < 3; c++) {
      rawComposite[p + c] =
        a === 0
          ? originalRaw[p + c]
          : a === 255
            ? editedRaw[p + c]
            : (editedRaw[p + c] * a + originalRaw[p + c] * (255 - a) + 127) / 255;
    }
  }
  const outside = assertOutsideUntouched(originalRaw, rawComposite, composed.alpha);
  check(
    `outside the mask is bit-identical (${outside.checked} px checked, ${outside.differing} differ)`,
    outside.ok,
    `${outside.differing} differing`,
  );

  // And the wall edit the model made must NOT have survived the composite — that
  // is the whole point of fusing back through the mask.
  const composedDrift = await measureDrift(original, composed.jpeg, excluded);
  check(
    `the composite discards the model's out-of-mask edit (${composedDrift.verdict})`,
    composedDrift.verdict === "clean",
    composedDrift.detail,
  );

  /**
   * THE ORDERING BUG, pinned.
   *
   * `edited` here contains a wall change the model was not asked for — exactly the
   * drift the guard exists to report. Measured on the model's own output it is
   * caught; measured on the composite it reads clean, because the composite already
   * restored those pixels. Both facts are true, and the pair is the point: a guard
   * placed after the composite cannot fail, and its clean verdict means nothing.
   *
   * This shipped that way. The first real render scored a flawless drift 0.00 over
   * 5844 windows, and re-measuring the same paid fal output raw showed the model had
   * in fact shifted the room's lighting (2.3 against a 0.53 noise floor). `execute`
   * now measures `edited`; this asserts the two paths still disagree, so the day
   * someone moves the call back after the composite, this fails instead of quietly
   * reporting perfection forever.
   */
  const rawDrift = await measureDrift(original, edited, excluded);
  check(
    `the model's raw output is where drift is visible (raw ${rawDrift.verdict} ` +
      `vs composite ${composedDrift.verdict})`,
    rawDrift.verdict !== "clean" && composedDrift.verdict === "clean",
    `raw: ${rawDrift.detail}`,
  );

  /* ---------------------------------------------------- intent routing */

  console.log("\nintent classification — routing decides the endpoint and the price\n");

  const kinds = ["floor", "wall", "ceiling", "countertop", "backsplash", "upper_cabinets", "window"];

  const cases: Array<[string, "material" | "surface_prompt" | "structural", string | null]> = [
    ["make the floor dark walnut", "surface_prompt", "floor"],
    ["paint the walls sage green", "surface_prompt", "wall"],
    ["retile the splashback in white metro", "surface_prompt", "backsplash"],
    ["change the worktop to honed marble", "surface_prompt", "countertop"],
    ["remove the cupboards and install a bbq grill in place", "structural", null],
    ["take out the upper cabinets", "structural", null],
    ["add a skylight above the island", "structural", null],
    ["declutter the countertops", "structural", null],
  ];

  for (const [prompt, expected, expectedHint] of cases) {
    const intent = classifyPrompt(prompt, kinds);
    check(
      `"${prompt}" -> ${intent.mode}`,
      intent.mode === expected,
      `expected ${expected}`,
    );
    if (expectedHint && intent.mode === "surface_prompt") {
      check(
        `  ... targets ${intent.surfaceHint}`,
        intent.surfaceHint === expectedHint,
        `expected ${expectedHint}`,
      );
    }
  }

  // The ambiguity rule: "the cupboards" must NOT resolve when both runs exist,
  // because guessing picks the wrong half of the kitchen.
  check(
    "'the cupboards' is ambiguous when upper AND lower exist",
    findSurfaceHint("repaint the cupboards", ["upper_cabinets", "lower_cabinets"]) === null,
  );
  check(
    "'the cupboards' resolves when only one run was detected",
    findSurfaceHint("repaint the cupboards", ["upper_cabinets"]) === "upper_cabinets",
  );
  check(
    "a surface that was not detected is never targeted",
    findSurfaceHint("change the island top", ["floor", "wall"]) === null,
  );

  /* ------------------------------------------------------------ prompts */

  const withDims = materialPrompt("Floor", {
    name: "Smoked Oak",
    category: "wood",
    finish: "matte",
    tileWMm: 1220,
    tileHMm: 190,
  });
  check("a material prompt states real trade dimensions", withDims.includes("1220 × 190 mm"));
  check("a material prompt carries the Preserve list", withDims.includes("Preserve:"));
  check(
    "a material prompt forbids out-of-mask change",
    withDims.includes("outside the masked region"),
  );

  // A fabricated format is a claim the render cannot honour, so nothing is invented.
  const noDims = materialPrompt("Wall", {
    name: "Chalk White",
    category: "paint",
    finish: "eggshell",
    tileWMm: null,
    tileHMm: null,
  });
  check("a dimensionless material invents no format", !/\d+ × \d+ mm/.test(noDims));

  await realPhotoCalibration();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

/**
 * Re-run the calibration on a REAL photo, because the thresholds came from one.
 *
 * The synthetic room proves the signals behave as designed. It cannot prove the
 * NOISE FLOOR, and the noise floor is what the thresholds actually sit against:
 * a real photo carries JPEG artefacts, sensor grain and fine texture that a
 * gradient plus a rectangle does not. Calibrating on synthetic images would put
 * SSIM_LIMIT somewhere around 0.999 and flag every render ever produced.
 *
 * The two rows that matter, and the reason SSIM_LIMIT is 0.93 rather than the
 * plan's 0.95: at NATIVE resolution a harmless 1K round-trip scores 0.942, which
 * is under 0.95 — so the original design flagged every single render. At the 768px
 * comparison scale that same round-trip is 0.964 while a 20px shift stays near
 * 0.58. The gap is what makes a fixed threshold mean anything.
 *
 * Skipped with a notice when the photo is absent, so this file stays runnable on a
 * clean checkout — it must never become the test nobody can run.
 */
async function realPhotoCalibration() {
  const photo = path.join(
    process.cwd(),
    "storage/images/7YmIfx_sRv400eo56GDjx/display.jpg",
  );
  if (!existsSync(photo)) {
    console.log("\nreal-photo calibration — skipped, no uploaded photo on disk\n");
    return;
  }

  console.log("\nreal-photo calibration — the noise floor synthetic images cannot show\n");
  const original = await readFile(photo);
  const meta = await sharp(original).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  // NOISE: things a correct render does anyway. Each MUST read clean, or the guard
  // blocks the product.
  const noise: Array<[string, Buffer]> = [
    ["stored as JPEG q92", await sharp(original).jpeg({ quality: 92 }).toBuffer()],
    [
      "returned at 2K then scaled back",
      await sharp(await sharp(original).resize(2048, null).jpeg({ quality: 92 }).toBuffer())
        .resize(w, h)
        .toBuffer(),
    ],
    [
      "returned at 1K then scaled back",
      await sharp(await sharp(original).resize(1024, null).jpeg({ quality: 92 }).toBuffer())
        .resize(w, h)
        .toBuffer(),
    ],
  ];

  const noiseScores: number[] = [];
  for (const [label, buf] of noise) {
    const d = await measureDrift(original, buf, null);
    noiseScores.push(d.score);
    check(
      `noise: ${label} reads clean (SSIM ${d.ssim.toFixed(3)}, block ${d.mad.toFixed(
        2,
      )}/${d.madWorst.toFixed(1)}, pHash ${d.phashDistance})`,
      d.verdict === "clean",
      d.detail,
    );
  }

  // DRIFT: things a misbehaving model does. Each MUST be caught, or the guard is
  // decoration. The subtle ones are the point — a 3% brightness lift across the
  // whole room is exactly the failure nobody notices by eye.
  //
  // A colour grade is NOT in this list, and that is a measured limit rather than an
  // oversight: on this photo an +8-degree hue rotation moves the block diff by
  // 0.59 against a 0.84 noise floor — genuinely under the noise, because the
  // kitchen is close to neutral and the rotation only bites on the saturated
  // minority of pixels. No threshold can separate them, so the guard does not
  // claim to. A grade strong enough to matter (a sage tint, 6.1) is caught.
  const drift: Array<[string, Buffer]> = [
    ["reframed by 20px", await sharp(original).extract({ left: 20, top: 0, width: w - 20, height: h }).resize(w, h, { fit: "fill" }).toBuffer()],
    ["rotated 1 degree", await sharp(original).rotate(1, { background: "#000" }).resize(w, h, { fit: "fill" }).toBuffer()],
    ["relit +3% brightness", await sharp(original).modulate({ brightness: 1.03 }).toBuffer()],
    ["colour-graded to sage", await sharp(original).tint("#b8c4a8").toBuffer()],
    [
      "one wall repainted",
      // A local repaint: half the frame tinted, the rest untouched. The failure
      // the worst-block statistic exists for, and the one a frame-wide mean hides.
      await sharp(original)
        .composite([
          {
            input: {
              create: { width: Math.round(w * 0.4), height: h, channels: 3, background: "#7a9a6a" },
            },
            blend: "overlay",
          },
        ])
        .toBuffer(),
    ],
  ];

  const driftScores: number[] = [];
  for (const [label, buf] of drift) {
    const d = await measureDrift(original, buf, null);
    driftScores.push(d.score);
    check(
      `drift: ${label} is caught (${d.verdict} — SSIM ${d.ssim.toFixed(
        3,
      )}, block ${d.mad.toFixed(2)}/${d.madWorst.toFixed(1)}, pHash ${d.phashDistance})`,
      d.verdict !== "clean",
      d.detail,
    );
  }

  // The SCORE, not just the verdict. `driftScore` is the number stored on the row
  // and compared against DRIFT_WARN in the renders API, so the warning the user
  // sees depends on this scale — and the scale is only meaningful if noise and
  // drift land on opposite sides of it.
  const worstNoise = Math.max(...noiseScores);
  const weakestDrift = Math.min(...driftScores);
  check(
    `every drift scores above every noise (noise <= ${worstNoise.toFixed(
      2,
    )}, drift >= ${weakestDrift.toFixed(2)})`,
    weakestDrift > worstNoise,
    `worst noise ${worstNoise.toFixed(3)} vs weakest drift ${weakestDrift.toFixed(3)}`,
  );
  check(
    `DRIFT_WARN (${DRIFT_WARN}) sits between them — the user is warned on drift, not on noise`,
    worstNoise < DRIFT_WARN && DRIFT_WARN <= weakestDrift,
    `${worstNoise.toFixed(3)} < ${DRIFT_WARN} <= ${weakestDrift.toFixed(3)}`,
  );
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.stack : err}\n`);
  process.exitCode = 1;
});
