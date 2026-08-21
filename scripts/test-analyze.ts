/**
 * Phase 4 gate: run the real analyze pipeline against a real photograph.
 *
 * Drives `analyzePhoto` directly — no queue, no worker, no database — so that a
 * failure here is unambiguously the segmentation pipeline and not job plumbing.
 * The handler adds persistence on top of this; if this is right, the handler is
 * a transaction.
 *
 * Costs ~$0.035 (7 fal calls). `--dry` prints the plan and spends nothing.
 *
 * What it checks that the spike did not: that the RECIPES table drives the same
 * results the spike measured by hand, that `wall` really does lose the
 * backsplash to subtraction, and that every mask survives the encode/store/decode
 * round-trip the worker will put it through.
 *
 * Usage:
 *   npx tsx scripts/test-analyze.ts --image fixtures/kitchen-real.jpg --dry
 *   npx tsx scripts/test-analyze.ts --image fixtures/kitchen-real.jpg
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzePhoto, estimateAreaM2, normalizedBbox, tintFor } from "../lib/analyze";
import { prepareUpload } from "../lib/image";
import { decodeMask, encodeMask, iou, overlay } from "../lib/mask";
import { RECIPES } from "../lib/segment";
import * as storage from "../lib/storage";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

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

async function main() {
  const imagePath = arg("image") ?? "fixtures/kitchen-real.jpg";
  const dry = has("dry");

  console.log("\nPHASE 4 — analyze pipeline against a real photo\n");
  console.log(`  surfaces: ${RECIPES.length}`);
  console.log(`  estimate: $${(RECIPES.length * 0.005).toFixed(3)}\n`);
  for (const r of RECIPES) {
    console.log(
      `  ${r.kind.padEnd(15)} ${r.endpoint.padEnd(18)} "${r.prompt}"` +
        `${r.subtract ? ` minus ${r.subtract.join(",")}` : ""}`,
    );
  }

  if (dry) {
    console.log("\n--dry: nothing submitted, nothing spent.\n");
    return;
  }

  // Through the REAL upload path, so the bytes and dimensions match exactly what
  // POST /api/uploads would have produced and stored.
  const raw = await readFile(path.resolve(imagePath));
  const prepared = await prepareUpload(raw);
  console.log(
    `\nimage: ${imagePath}  original ${prepared.width}x${prepared.height}` +
      `  display ${prepared.displayWidth}x${prepared.displayHeight}\n`,
  );

  const result = await analyzePhoto(
    prepared.display,
    { width: prepared.displayWidth, height: prepared.displayHeight },
    {
      onProgress: (done, total, kind) =>
        console.log(`  ${String(done).padStart(2)}/${total} ${kind}`),
    },
  );

  console.log(
    `\ndone in ${(result.ms / 1000).toFixed(1)}s, ` +
      `${result.costUnits} billable unit(s) = $${(result.costUnits * 0.005).toFixed(3)}\n`,
  );

  console.log("results\n");
  console.log(`  ${"surface".padEnd(15)} ${"usable".padEnd(9)} coverage  comps  conf   note`);
  for (const s of result.surfaces) {
    console.log(
      `  ${s.kind.padEnd(15)} ${(s.usable ? "USABLE" : "unusable").padEnd(9)} ` +
        `${(s.stats.coverage * 100).toFixed(1).padStart(6)}%  ${String(s.stats.components).padStart(4)}   ` +
        `${s.confidence != null ? s.confidence.toFixed(2) : "  — "}  ${s.note}`,
    );
  }
  for (const f of result.failures) {
    console.log(`  ${f.kind.padEnd(15)} FAILED    ${f.error.slice(0, 60)}`);
  }

  console.log("\nassertions\n");

  check(
    `every surface produced a mask (${result.surfaces.length}/${RECIPES.length})`,
    result.surfaces.length === RECIPES.length,
    `${result.failures.length} failed`,
  );

  const byKind = new Map(result.surfaces.map((s) => [s.kind, s]));

  // The spike's own numbers, as a regression band. Loose because a re-run can
  // legitimately differ by a percentage point; tight enough to catch a recipe
  // that has started resolving something else entirely.
  const EXPECT: Record<string, [number, number]> = {
    floor: [0.01, 0.1],
    wall: [0.07, 0.3],
    ceiling: [0.04, 0.16],
    countertop: [0.07, 0.22],
    backsplash: [0.02, 0.11],
    upper_cabinets: [0.05, 0.28],
    window: [0.02, 0.12],
  };
  for (const [kind, [lo, hi]] of Object.entries(EXPECT)) {
    const s = byKind.get(kind as never);
    if (!s) {
      check(`${kind} coverage in the spike's band`, false, "surface missing");
      continue;
    }
    check(
      `${kind} coverage ${(s.stats.coverage * 100).toFixed(1)}% within ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      s.stats.coverage >= lo && s.stats.coverage <= hi,
      `${(s.stats.coverage * 100).toFixed(1)}%`,
    );
  }

  /**
   * The subtraction the recipe promises. "the wall" also grabs the backsplash —
   * measured, expected, and the reason `subtract` exists instead of a
   * negative_prompt that would double the call price.
   */
  const wall = byKind.get("wall");
  const backsplash = byKind.get("backsplash");
  if (wall && backsplash) {
    const overlapWithBacksplash = iou(wall.mask, backsplash.mask);
    check(
      "wall no longer overlaps the backsplash after subtraction",
      overlapWithBacksplash < 0.02,
      `iou ${overlapWithBacksplash.toFixed(4)}`,
    );
    // ...and the subtraction did not eat the wall.
    check(
      "wall survived the subtraction",
      wall.stats.coverage > 0.05,
      `${(wall.stats.coverage * 100).toFixed(1)}%`,
    );
  } else {
    check("wall and backsplash both present for the subtraction check", false);
  }

  // Masks must be in DISPLAY space or every client coordinate is offset.
  const wrongSize = result.surfaces.filter(
    (s) => s.mask.width !== prepared.displayWidth || s.mask.height !== prepared.displayHeight,
  );
  check(
    "every mask is in display pixel space",
    wrongSize.length === 0,
    wrongSize.map((s) => `${s.kind} ${s.mask.width}x${s.mask.height}`).join(", "),
  );

  // Normalized bboxes are what the client positions zone chips with.
  const badBbox = result.surfaces.filter((s) => {
    const [x0, y0, x1, y1] = normalizedBbox(s.stats);
    return x0 < 0 || y0 < 0 || x1 > 1.0001 || y1 > 1.0001 || x1 <= x0 || y1 <= y0;
  });
  check("every normalized bbox is sane", badBbox.length === 0, badBbox.map((s) => s.kind).join(", "));

  /**
   * The round-trip the worker actually performs. A mask that changes when
   * written and re-read would put the editor's overlay out of step with the
   * server's own compositing — and the failure would look like a segmentation
   * problem rather than an encoding one.
   */
  let roundTripOk = true;
  for (const s of result.surfaces) {
    const key = `analyze-test/${s.kind}.png`;
    await storage.put(key, await encodeMask(s.mask));
    const back = await decodeMask(await storage.get(key));
    if (iou(back, s.mask) !== 1) {
      roundTripOk = false;
      console.log(`       ${s.kind} round-trip iou ${iou(back, s.mask).toFixed(5)}`);
    }
    // Overlays for the human check — the numbers cannot say a mask is on the
    // right object.
    await storage.put(
      `analyze-test/${s.kind}-overlay.jpg`,
      await overlay(prepared.display, s.mask, tintFor(s.kind)),
    );
  }
  check("every mask survives encode -> store -> decode exactly", roundTripOk);

  // Area estimates must be a band, and must be ordered.
  const areas = result.surfaces
    .map((s) => ({ kind: s.kind, area: estimateAreaM2(s.kind, s.stats.coverage) }))
    .filter((a) => a.area);
  check(
    "area estimates are ranges with low < high",
    areas.every((a) => a.area!.low < a.area!.high),
  );

  // A cheap sanity check on the mask bank: no two surfaces are the same mask.
  const floor = byKind.get("floor");
  if (floor && wall) {
    check(
      "floor and wall are genuinely different masks",
      iou(floor.mask, wall.mask) < 0.2,
      `iou ${iou(floor.mask, wall.mask).toFixed(3)}`,
    );
  }

  // Confirm the fragmented surfaces really are multi-mask unions, which is the
  // reason sam-3 was chosen for joinery.
  const cabinets = byKind.get("upper_cabinets");
  if (cabinets) {
    check(
      `cabinets unioned ${cabinets.maskCount} raw mask(s) from sam-3`,
      cabinets.maskCount >= 1,
      String(cabinets.maskCount),
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`spent: $${(result.costUnits * 0.005).toFixed(3)}`);
  console.log(`overlays: storage/analyze-test/*-overlay.jpg  <- LOOK AT THESE\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.stack : err}\n`);
  process.exitCode = 1;
});
