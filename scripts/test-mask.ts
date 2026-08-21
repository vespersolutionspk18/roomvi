/**
 * Tests for lib/mask.ts against synthetic masks with known answers.
 *
 * Worth doing before the segmentation spike, not after: these functions are what
 * decides "usable" vs "unusable" for every fal response, and a bug in
 * `judgeMask` would make a paid experiment report the wrong conclusion. Cheaper
 * to prove the ruler is straight than to re-run the measurements.
 *
 * Run with `npx tsx scripts/test-mask.ts`.
 */
import sharp from "sharp";
import {
  analyzeMask,
  cleanMask,
  decodeMask,
  dilateMask,
  encodeMask,
  erodeMask,
  iou,
  judgeMask,
  largestComponent,
  subtract,
  union,
  type Mask,
} from "../lib/mask";

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
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

const W = 200;
const H = 100;

function blank(): Mask {
  return { data: new Uint8Array(W * H), width: W, height: H };
}

function rect(x0: number, y0: number, x1: number, y1: number, into = blank()): Mask {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) into.data[y * W + x] = 255;
  }
  return into;
}

async function main() {
  console.log("\n1. geometry: coverage, bbox, edges, centroid");
  {
    // Bottom half: what a floor mask looks like.
    const floor = rect(0, 50, W - 1, H - 1);
    const s = analyzeMask(floor);
    check("coverage is 0.5", near(s.coverage, 0.5), String(s.coverage));
    check("one component", s.components === 1, String(s.components));
    check("largest holds everything", near(s.largestShare, 1));
    check("touches bottom, not top", s.touches.bottom && !s.touches.top);
    check("bbox spans the lower half", s.bbox.y === 50 && s.bbox.h === 50 && s.bbox.w === W);
    check("centroid sits low", near(s.centroid.y, 0.745, 0.02), String(s.centroid.y));
    check("nothing in the upper half", s.upperHalfShare === 0);
  }

  console.log("\n2. component counting and speckle");
  {
    const speckle = blank();
    // 30 dots, each 2x2 = 4px. Frame is 20,000px, so the noise floor is 16 —
    // these are below it and must NOT be counted as components.
    for (let i = 0; i < 30; i++) {
      const x = 3 + (i % 10) * 19;
      const y = 3 + Math.floor(i / 10) * 30;
      rect(x, y, x + 1, y + 1, speckle);
    }
    const tiny = analyzeMask(speckle);
    check("sub-noise-floor dots are ignored", tiny.components === 0, String(tiny.components));

    // 12 blobs of 5x5 = 25px each, above the floor of 16.
    const blobs = blank();
    for (let i = 0; i < 12; i++) {
      const x = 4 + (i % 6) * 30;
      const y = 4 + Math.floor(i / 6) * 40;
      rect(x, y, x + 4, y + 4, blobs);
    }
    const bs = analyzeMask(blobs);
    check("12 real fragments are counted", bs.components === 12, String(bs.components));
    check("no dominant component", bs.largestShare < 0.2, String(bs.largestShare));
    // Judged as a FLOOR, not a wall: `wall` is exempt from the speckle rule
    // because cabinets and doorways genuinely cut a wall into pieces (see
    // NATURALLY_FRAGMENTED), so it is the wrong kind to test speckle with.
    check("judged unusable as speckle", !judgeMask("floor", bs).usable);

    /**
     * The exemption, and its limit. A real "the wall" mask from the spike came
     * back as 13 legitimate components — wall left of the window, behind the
     * doorway, above the cabinets — and the generic speckle rule rejected it.
     * Fragmentation alone must not condemn a wall; absurd fragmentation still must.
     */
    const wallish = blank();
    for (let i = 0; i < 12; i++) {
      const x = 2 + (i % 6) * 33;
      const y = 2 + Math.floor(i / 6) * 40;
      rect(x, y, x + 25, y + 32, wallish); // 26x33 pieces -> ~51% total
    }
    const ws = analyzeMask(wallish);
    check("a 12-piece wall is NOT called speckle", judgeMask("wall", ws).usable, judgeMask("wall", ws).note);
    check("...while the same shape IS speckle as a floor", !judgeMask("floor", ws).usable);

    const dust = blank();
    for (let i = 0; i < 70; i++) {
      const x = 1 + (i % 14) * 14;
      const y = 1 + Math.floor(i / 14) * 20;
      rect(x, y, x + 5, y + 5, dust); // 6x6 = 36px each, above the noise floor
    }
    const ds = analyzeMask(dust);
    check("70 fragments is dust even for a wall", !judgeMask("wall", ds).usable, judgeMask("wall", ds).note);
  }

  console.log("\n3. judgeMask catches the failures that look plausible");
  {
    check("empty mask rejected", !judgeMask("floor", analyzeMask(blank())).usable);

    const all = rect(0, 0, W - 1, H - 1);
    const allV = judgeMask("floor", analyzeMask(all));
    check("whole-frame grab rejected", !allV.usable, allV.note);

    // A wall: correct shape, but in the top half — must fail AS A FLOOR.
    // Sized at 41% so it sits inside the ceiling scale bound (max 45%) and the
    // assertion below tests POSITION, not size.
    const top = rect(0, 0, W - 1, 40);
    const asFloor = judgeMask("floor", analyzeMask(top));
    const asCeiling = judgeMask("ceiling", analyzeMask(top));
    check("upper-frame region rejected as floor", !asFloor.usable, asFloor.note);
    check("...but accepted as ceiling", asCeiling.usable, asCeiling.note);

    // A floating floor-ish region that never reaches the bottom edge: the
    // signature of a mask that latched onto a rug instead of the floor.
    const floating = rect(20, 55, 180, 80);
    const fv = judgeMask("floor", analyzeMask(floating));
    check("floor not touching the bottom edge rejected", !fv.usable, fv.note);

    const good = rect(0, 55, W - 1, H - 1);
    check("a plausible floor is accepted", judgeMask("floor", analyzeMask(good)).usable);
  }

  console.log("\n3b. per-surface scale — the case the spike got wrong");
  {
    /**
     * Regression for a real false pass. The Phase 3.5 spike reported a "wall"
     * mask holding 1.9% of the frame as usable: a sliver beside a door, in a
     * photo whose beige wall spans a third of the image. Every generic check
     * passed it — not empty, not the whole frame, one clean component.
     */
    const sliver = rect(60, 10, 79, 70); // 20x61 = 1220px of 20000 -> 6.1%
    const slim = analyzeMask(sliver);
    check("a 6% region is too small to be a wall", !judgeMask("wall", slim).usable, judgeMask("wall", slim).note);

    /**
     * ...and the asymmetry that makes a per-kind table necessary rather than one
     * global floor: the SAME 3% coverage is a miss for a wall and correct for a
     * floor, because an island and stools legitimately hide almost all of a
     * floor while nothing occludes a wall that thoroughly. This is the ratio the
     * spike actually produced — floor 3.5%, wall 1.9%.
     */
    const strip = rect(0, 97, W - 1, H - 1); // 200x3 = 600px of 20000 -> 3%
    check("3% along the bottom passes as a floor", judgeMask("floor", analyzeMask(strip)).usable);
    check("...and the same region fails as a wall", !judgeMask("wall", analyzeMask(strip)).usable);

    // A wall at a believable size still passes.
    const realWall = rect(0, 5, 120, 60); // 121x56 = 6776 -> 33.9%
    check("a 34% region passes as a wall", judgeMask("wall", analyzeMask(realWall)).usable);

    // Upper bounds catch the opposite failure: a backsplash prompt that took the
    // whole wall. Not caught by the whole-frame check, which needs >92%.
    const spilled = rect(0, 0, W - 1, 59); // 60% of frame
    const bs = judgeMask("backsplash", analyzeMask(spilled));
    check("a 60% backsplash is rejected as spilled", !bs.usable, bs.note);
    check("...but 60% is fine for a wall", judgeMask("wall", analyzeMask(spilled)).usable);

    // An unknown kind has no expectation and must not be rejected on scale.
    check("unknown surface kinds skip the scale check", judgeMask("mystery", slim).usable);
  }

  console.log("\n4. set operations");
  {
    const floor = rect(0, 50, W - 1, H - 1);
    // The chair must span the FULL height of the floor to split it. An earlier
    // version of this test used y 60..99 and left a 10px strip along y 50..59
    // holding the two sides together — the assertion was wrong, not the code.
    const chair = rect(80, 50, 120, H - 1);
    const cut = subtract(floor, chair);
    const cs = analyzeMask(cut);
    check(
      "subtract removes exactly the chair's pixels",
      near(cs.coverage, 0.5 - (41 * 50) / (W * H), 0.001),
      String(cs.coverage),
    );
    check("a full-height occluder splits the floor in two", cs.components === 2, String(cs.components));

    // ...and one that does not reach the far edge leaves it connected.
    const rug = subtract(floor, rect(80, 60, 120, H - 1));
    check("a partial occluder does NOT split it", analyzeMask(rug).components === 1);

    const back = union([cut, chair]);
    check("union restores the original", iou(back, floor) === 1);

    const left = rect(0, 50, 99, H - 1);
    check("iou of disjoint halves is 0", iou(left, rect(100, 50, W - 1, H - 1)) === 0);
    check("iou of half against whole is 0.5", near(iou(left, floor), 0.5, 0.001));

    const only = largestComponent(cut);
    const os = analyzeMask(only);
    check("largestComponent keeps one piece", os.components === 1);
    check("...and it is the bigger side", os.bbox.x === 0 && os.bbox.w === 80, JSON.stringify(os.bbox));
  }

  console.log("\n5. decode: the three shapes fal actually returns");
  {
    const src = rect(40, 20, 160, 80);
    const png = await encodeMask(src);

    const grey = await decodeMask(png);
    check("1-channel PNG round-trips exactly", iou(grey, src) === 1);

    const rgb = await sharp(png).removeAlpha().toColourspace("srgb").png().toBuffer();
    check("RGB PNG decodes via luma", iou(await decodeMask(rgb), src) === 1);

    /**
     * The dangerous one: mask in ALPHA over black RGB. Reading colour channels
     * gives an all-zero mask — a silent wrong answer, not an error.
     */
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < src.data.length; i++) {
      rgba[i * 4 + 3] = src.data[i] ? 255 : 0; // RGB stays black
    }
    const alphaPng = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
      .png()
      .toBuffer();
    const decoded = await decodeMask(alphaPng);
    check("alpha-carried mask is recovered, not read as empty", iou(decoded, src) === 1, String(iou(decoded, src)));
  }

  console.log("\n6. morphology: sharp's dilate/erode are INVERTED");
  {
    /**
     * Pins the surprise that caused a real bug. sharp's own doc says dilate
     * "expands foreground objects", but on a mask it SHRINKS white. If a future
     * sharp release fixes this, these two assertions fail loudly instead of
     * `cleanMask` silently doing open-then-close again.
     */
    const square = rect(90, 40, 109, 59); // 20x20 = 400px
    const grown = analyzeMask(await dilateMask(square, 3));
    const shrunk = analyzeMask(await erodeMask(square, 3));
    const area = (s: { coverage: number }) => Math.round(s.coverage * W * H);
    check("dilateMask grows the white region", area(grown) > 400, `${area(grown)}px from 400`);
    check("erodeMask shrinks it", area(shrunk) < 400, `${area(shrunk)}px from 400`);
    check("...and shrinking cannot exceed growing", area(shrunk) < area(grown));
  }

  console.log("\n7. cleanMask closes pinholes and drops speckle");
  {
    const surface = rect(20, 20, 180, 80);
    /**
     * Holes must be bigger than one pixel to register as separate components —
     * a 1px hole is surrounded by 4-connected white and does not disconnect
     * anything. The first version of this test punched single pixels and then
     * asserted "starts fragmented", which was never true.
     */
    let punched = 0;
    for (let i = 0; i < 20; i++) {
      const x = 30 + (i % 10) * 14;
      const y = 30 + Math.floor(i / 10) * 22;
      rect(x, y, x + 2, y + 2, surface);
      for (let yy = y; yy <= y + 2; yy++) for (let xx = x; xx <= x + 2; xx++) surface.data[yy * W + xx] = 0;
      punched++;
    }
    // Detached flecks, sized so an open() of radius 3 actually removes them, and
    // placed in the empty band below the surface (which ends at y=80). Kept off
    // the frame edge: libvips treats the outside as background, so a blob in a
    // corner is clipped and survives an open that erases the same blob in open
    // space — which is real behaviour, but not what this assertion is about.
    rect(30, 86, 34, 90, surface);
    rect(150, 86, 154, 90, surface);

    const before = analyzeMask(surface);
    check("starts fragmented by detached flecks", before.components === 3, String(before.components));

    const after = analyzeMask(await cleanMask(surface, 3));
    check("ends as a single region", after.components === 1, `${after.components}`);
    check(
      `coverage grows — ${punched} pinholes filled`,
      after.coverage > before.coverage,
      `${before.coverage.toFixed(5)} -> ${after.coverage.toFixed(5)}`,
    );
    check("the surface itself survives", after.coverage > 0.35, String(after.coverage));
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
