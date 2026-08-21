/**
 * Follow-up to the Phase 3.5 spike: fix the one surface that failed.
 *
 * The spike settled the main question — both endpoints DO resolve architectural
 * surfaces — but `wall` came back as a fragment from both: 5.3% from evf-sam and
 * 1.9% from sam-3, on a photo whose beige wall spans a third of the frame. The
 * suspect is the prompt, not the model. "the painted wall surfaces of the room"
 * is plural and abstract, and both endpoints resolve a single referent best.
 *
 * Deliberately narrow: one surface, N phrasings, $0.005 each, reusing the mask
 * and judging code the spike already validated. Cheaper than another full sweep
 * and it answers the only open question.
 *
 * Usage:
 *   npx tsx scripts/spike-wall.ts --image fixtures/kitchen-real.jpg --dry
 *   npx tsx scripts/spike-wall.ts --image fixtures/kitchen-real.jpg
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as fal from "../lib/fal";
import {
  analyzeMask,
  cleanMask,
  decodeMask,
  encodeMask,
  judgeMask,
  overlay,
  resizeMask,
  type Mask,
} from "../lib/mask";
import * as storage from "../lib/storage";

const EVF_SAM = "fal-ai/evf-sam";
const SAM3 = "fal-ai/sam-3/image";
const PRICE_PER_CALL = 0.005;

/**
 * Phrasings to try, cheapest hypothesis first.
 *
 * The three ideas under test: a bare singular noun phrase; naming the wall by
 * its colour so the model has something concrete to latch onto; and asking for
 * the wall by what it is NOT (the background behind the fittings), which is how
 * "stuff" classes are usually described.
 */
const TRIALS: Array<{ label: string; endpoint: "evf" | "sam3"; prompt: string }> = [
  { label: "singular", endpoint: "evf", prompt: "the wall" },
  { label: "by-colour", endpoint: "evf", prompt: "the beige painted wall" },
  { label: "as-background", endpoint: "evf", prompt: "the flat wall behind the cabinets and doorway" },
  // sam-3 is a detector; "wall" gave 1.9%. Worth one call to see if a slightly
  // richer noun phrase helps before writing the endpoint off for stuff classes.
  { label: "sam3-painted", endpoint: "sam3", prompt: "painted wall" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

type EvfOutput = { image?: { url: string }; mask?: { url: string }; url?: string };
type Sam3Output = { masks: Array<{ url: string }>; scores?: number[] };

async function main() {
  const imagePath = arg("image");
  const dry = has("dry");

  console.log("\nwall prompt trials\n");
  for (const t of TRIALS) {
    console.log(`  ${t.label.padEnd(15)} ${(t.endpoint === "evf" ? EVF_SAM : SAM3).padEnd(18)} "${t.prompt}"`);
  }
  console.log(`\n  estimate: $${(TRIALS.length * PRICE_PER_CALL).toFixed(3)}`);
  console.log(`  baseline to beat: evf 5.3%, sam3 1.9% — both judged too small for a wall\n`);

  if (dry) {
    console.log("--dry: nothing submitted, nothing spent.\n");
    return;
  }
  if (!imagePath) throw new Error("No --image given.");

  // Same preparation as the spike, so results are comparable to its numbers.
  const original = await readFile(path.resolve(imagePath));
  const prepared = await sharp(original)
    .rotate()
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const pm = await sharp(prepared).metadata();
  const imageUrl = await fal.upload(prepared, "spike-room.jpg", "image/jpeg");

  let spent = 0;
  for (const t of TRIALS) {
    process.stdout.write(`  ${t.label.padEnd(15)} `);
    try {
      const endpoint = t.endpoint === "evf" ? EVF_SAM : SAM3;
      const input =
        t.endpoint === "evf"
          ? { image_url: imageUrl, prompt: t.prompt, semantic_type: true, fill_holes: true, mask_only: true }
          : { image_url: imageUrl, prompt: t.prompt, apply_mask: false, include_scores: true };

      const { data } = await fal.run<EvfOutput | Sam3Output>(endpoint, input, { timeoutMs: 180_000 });
      spent += PRICE_PER_CALL;

      const urls =
        t.endpoint === "evf"
          ? [(data as EvfOutput).mask?.url ?? (data as EvfOutput).image?.url ?? (data as EvfOutput).url]
              .filter(Boolean) as string[]
          : ((data as Sam3Output).masks ?? []).map((m) => m.url);

      if (urls.length === 0) {
        console.log("no mask returned");
        continue;
      }

      let mask: Mask = await decodeMask(await fal.download(urls[0]));
      if (mask.width !== pm.width || mask.height !== pm.height) {
        mask = await resizeMask(mask, pm.width!, pm.height!);
      }
      mask = await cleanMask(mask, 3);

      const stats = analyzeMask(mask);
      const v = judgeMask("wall", stats);
      const base = `spike/wall-trial-${t.label}`;
      await storage.put(`${base}.png`, await encodeMask(mask));
      await storage.put(`${base}-overlay.jpg`, await overlay(prepared, mask, [169, 131, 79]));

      console.log(
        `${v.usable ? "USABLE " : "unusable"} cov ${(stats.coverage * 100).toFixed(1)}% ` +
          `comp ${stats.components} — ${v.note}`,
      );
    } catch (err) {
      console.log(`ERROR ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    }
  }

  console.log(`\n  spent: $${spent.toFixed(3)}`);
  console.log(`  overlays: storage/spike/wall-trial-*-overlay.jpg  <- LOOK AT THESE\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
