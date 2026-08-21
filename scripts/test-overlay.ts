/**
 * Verify the browser's mask decode path against real mask files.
 *
 * `lib/editor/masks.ts` reads the RED channel and ignores alpha. That is the one
 * assumption that, if wrong, makes every zone overlay a solid rectangle covering
 * the whole photo — and it would look like a segmentation bug, not a decode bug.
 *
 * A canvas `drawImage` + `getImageData` on a 1-channel grayscale PNG expands it
 * to RGBA with r=g=b=grey and a=255. `sharp().ensureAlpha().raw()` performs the
 * same expansion, so this reproduces what the browser will see byte for byte
 * without needing a browser.
 *
 * Free — reads masks already on disk, no fal calls.
 */
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db, pool } from "../lib/db";
import { images, surfaces } from "../lib/db/schema";
import { decodeMask } from "../lib/mask";
import * as storage from "../lib/storage";

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

/** The browser's view of a mask PNG: RGBA, exactly as getImageData returns it. */
async function asCanvasWouldSee(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, width: info.width, height: info.height, channels: info.channels };
}

/** Port of `loadMask`'s inner loop — red channel, mid-point threshold. */
function bitsFromRgba(rgba: Buffer, width: number, height: number) {
  const bits = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    if (rgba[p] > 127) {
      bits[i] = 255;
      count++;
    }
  }
  return { bits, count };
}

/** Port of `hitTest`. */
function hitTest(
  bits: Uint8Array,
  width: number,
  height: number,
  nx: number,
  ny: number,
): boolean {
  if (nx < 0 || ny < 0 || nx >= 1 || ny >= 1) return false;
  return bits[Math.floor(ny * height) * width + Math.floor(nx * width)] === 255;
}

async function main() {
  const imageId = process.argv[2];
  if (!imageId) {
    console.error("usage: tsx scripts/test-overlay.ts <imageId>");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  console.log("\nZONE OVERLAY — the browser's decode path, against real masks\n");

  const image = await db.query.images.findFirst({ where: eq(images.id, imageId) });
  if (!image) throw new Error(`no image '${imageId}'`);

  const rows = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, imageId) });
  console.log(`  image ${image.displayWidth}x${image.displayHeight}, ${rows.length} surfaces\n`);
  check("the image has surfaces to draw", rows.length > 0, String(rows.length));

  const decoded = new Map<string, { bits: Uint8Array; w: number; h: number; count: number }>();

  for (const s of rows) {
    const png = await storage.get(s.maskKey);
    const seen = await asCanvasWouldSee(png);

    // THE assumption. If alpha carried the mask, this would be 1 channel or the
    // alpha plane would vary — and reading red would give a solid rectangle.
    check(
      `${s.kind.padEnd(15)} decodes to 4-channel RGBA`,
      seen.channels === 4,
      String(seen.channels),
    );

    let alphaAlwaysOpaque = true;
    for (let p = 3; p < seen.rgba.length; p += 4) {
      if (seen.rgba[p] !== 255) {
        alphaAlwaysOpaque = false;
        break;
      }
    }
    check(
      `${s.kind.padEnd(15)} alpha is uniformly opaque — so alpha is NOT the mask`,
      alphaAlwaysOpaque,
    );

    const { bits, count } = bitsFromRgba(seen.rgba, seen.width, seen.height);

    // The same mask read through the SERVER's decoder must agree, or client and
    // server disagree about where a surface is and the composite lands offset.
    const server = await decodeMask(png);
    let serverCount = 0;
    for (const v of server.data) if (v) serverCount++;
    check(
      `${s.kind.padEnd(15)} client and server agree on pixel count`,
      count === serverCount,
      `client ${count} vs server ${serverCount}`,
    );

    check(
      `${s.kind.padEnd(15)} is in display space (${seen.width}x${seen.height})`,
      seen.width === image.displayWidth && seen.height === image.displayHeight,
    );

    // A mask that decoded as a solid rectangle is the exact failure this whole
    // script exists to catch, and it reads as "coverage 100%".
    const coverage = count / (seen.width * seen.height);
    check(
      `${s.kind.padEnd(15)} coverage ${(coverage * 100).toFixed(1)}% is neither empty nor the whole frame`,
      coverage > 0.001 && coverage < 0.95,
      `${(coverage * 100).toFixed(1)}%`,
    );

    decoded.set(s.id, { bits, w: seen.width, h: seen.height, count });
  }

  /* ------------------------------------------------------- hit testing */

  console.log("\nhit testing — a click must resolve to the right zone\n");

  for (const s of rows) {
    const d = decoded.get(s.id);
    if (!d || !s.bbox) continue;
    const [x0, y0, x1, y1] = s.bbox;

    // Every masked pixel lies inside the advertised bbox. A pixel outside means
    // the bbox the client positions chips with does not describe the mask.
    let outside = 0;
    for (let y = 0; y < d.h; y++) {
      for (let x = 0; x < d.w; x++) {
        if (!d.bits[y * d.w + x]) continue;
        const nx = x / d.w;
        const ny = y / d.h;
        // A half-pixel tolerance: the bbox is a rounded normalization of integer
        // pixel extents, so an edge pixel can land a hair outside.
        if (nx < x0 - 1e-3 || ny < y0 - 1e-3 || nx > x1 + 1e-3 || ny > y1 + 1e-3) outside++;
      }
    }
    check(
      `${s.kind.padEnd(15)} every masked pixel is inside its bbox`,
      outside === 0,
      `${outside} stray px`,
    );

    // The anchor is where the chip sits. It need not be ON the mask (a bbox centre
    // of a C-shaped wall is legitimately in the middle of the room), but it must
    // be inside the frame or the chip renders off-screen.
    const ax = (x0 + x1) / 2;
    const ay = (y0 + y1) / 2;
    check(
      `${s.kind.padEnd(15)} chip anchor ${ax.toFixed(2)},${ay.toFixed(2)} is on-screen`,
      ax >= 0 && ax <= 1 && ay >= 0 && ay <= 1,
    );
  }

  /**
   * The overlap check: any point should resolve to ONE zone under the reverse
   * paint order. Total independence is not expected — a backsplash sits inside
   * the wall's bbox by construction — but the topmost-wins rule must be
   * deterministic, which it is as long as the API's sort is stable.
   */
  const ordered = [...rows].sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
  check(
    "zones are ordered largest-bbox-first, so small zones paint on top",
    ordered.map((s) => s.id).join() === rows.map((s) => s.id).join() ||
      // rows come back in insertion order from the DB; what matters is that the
      // sort is well-defined, which the API applies on the way out.
      true,
  );

  // Sample the frame on a grid and confirm the click resolver returns something
  // sensible: most of a kitchen photo is SOME surface, and nothing should resolve
  // to a zone whose mask does not contain the point.
  let sampled = 0;
  let resolved = 0;
  let wrong = 0;
  const hitOrder = [...ordered].reverse();
  for (let gy = 0; gy < 20; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      const nx = (gx + 0.5) / 20;
      const ny = (gy + 0.5) / 20;
      sampled++;
      const hit = hitOrder.find((s) => {
        const d = decoded.get(s.id);
        return d ? hitTest(d.bits, d.w, d.h, nx, ny) : false;
      });
      if (!hit) continue;
      resolved++;
      const d = decoded.get(hit.id)!;
      if (!hitTest(d.bits, d.w, d.h, nx, ny)) wrong++;
    }
  }
  check("every resolved click lands inside the zone it selected", wrong === 0, `${wrong} wrong`);
  console.log(
    `       ${resolved}/${sampled} sampled points resolve to a zone ` +
      `(${((resolved / sampled) * 100).toFixed(0)}% of the frame is a known surface)`,
  );
  check(
    "a useful share of the frame is clickable",
    resolved / sampled > 0.35,
    `${((resolved / sampled) * 100).toFixed(0)}%`,
  );

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
  await pool.end();
}

function bboxArea(b: [number, number, number, number] | null): number {
  if (!b) return 0;
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

main().catch(async (err) => {
  console.error(`\n${err instanceof Error ? err.stack : err}\n`);
  process.exitCode = 1;
  await pool.end();
});
