/**
 * Re-judge the spike's stored masks against the current `judgeMask`.
 *
 * The spike costs $0.055 per run; the verdicts it prints cost nothing to redo,
 * because every mask was written to storage/spike/ before being judged. When the
 * ruler changes — as it did after the spike passed a 1.9% "wall" — this replays
 * the measurement over the same bytes instead of re-buying the masks.
 *
 * Doubles as a round-trip check: these masks come back through storage and
 * `decodeMask`, so a mask that survives here is one the analyze pipeline can
 * actually reload rather than one that only ever existed in memory.
 *
 * Run with `npx tsx scripts/rejudge-spike.ts`.
 */
import { analyzeMask, decodeMask, judgeMask } from "../lib/mask";
import * as storage from "../lib/storage";

/** Mask filenames are `<kind>-<endpoint>.png`, written by spike-segment.ts. */
const MASKS: Array<[kind: string, endpoint: string]> = [
  ["floor", "evf"],
  ["floor", "sam3"],
  ["wall", "evf"],
  ["wall", "sam3"],
  ["ceiling", "evf"],
  ["countertop", "evf"],
  ["countertop", "sam3"],
  ["backsplash", "evf"],
  ["cupboard", "evf"],
  ["cupboard", "sam3"],
  ["window", "sam3"],
];

async function main() {
  console.log("\nre-judging stored spike masks — no fal calls, nothing spent\n");
  console.log(`  ${"surface/endpoint".padEnd(20)} ${"verdict".padEnd(9)} coverage  comps  note`);

  let usable = 0;
  for (const [kind, endpoint] of MASKS) {
    const key = `spike/${kind}-${endpoint}.png`;
    let bytes: Buffer;
    try {
      bytes = await storage.get(key);
    } catch {
      console.log(`  ${`${kind}/${endpoint}`.padEnd(20)} MISSING   (run npm run spike:segment first)`);
      continue;
    }

    const stats = analyzeMask(await decodeMask(bytes));
    const v = judgeMask(kind, stats);
    if (v.usable) usable++;

    console.log(
      `  ${`${kind}/${endpoint}`.padEnd(20)} ${(v.usable ? "USABLE" : "unusable").padEnd(9)} ` +
        `${(stats.coverage * 100).toFixed(1).padStart(6)}%  ${String(stats.components).padStart(4)}   ${v.note}`,
    );
  }

  console.log(`\n  usable: ${usable}/${MASKS.length}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
