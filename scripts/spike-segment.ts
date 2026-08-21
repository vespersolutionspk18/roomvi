/**
 * PHASE 3.5 — the segmentation spike.
 *
 * This settles the one unverified assumption the whole product rests on: can
 * fal's promptable segmenters resolve ARCHITECTURAL SURFACES ("the floor", "the
 * countertop", "the upper cabinets") rather than only the discrete objects every
 * doc example shows ("wheel", "cat")? Phases 4-7 all assume yes. Finding out
 * costs a few cents; finding out after building on it costs the build.
 *
 * Deliberately a script and not a job: it runs once, by hand, with a human
 * looking at the overlays. It writes every mask AND a tinted overlay to
 * storage/spike/, plus a results.md table, because the numbers can tell you a
 * mask is well-formed but not that it is on the right object.
 *
 * Cost control, since this spends real credits:
 *   - every call is $0.005; the run prints a total before and after
 *   - --dry prints the plan and spends nothing
 *   - --limit N caps the number of calls
 *   - no `negative_prompt` anywhere: it DOUBLES the price on evf-sam, and the
 *     same subtraction is free locally via mask.subtract()
 *
 * Usage:
 *   npx tsx scripts/spike-segment.ts --image path/to/kitchen.jpg --dry
 *   npx tsx scripts/spike-segment.ts --image path/to/kitchen.jpg
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
  largestComponent,
  overlay,
  resizeMask,
  union,
  type Mask,
  type MaskStats,
} from "../lib/mask";
import * as storage from "../lib/storage";

const EVF_SAM = "fal-ai/evf-sam";
const SAM3 = "fal-ai/sam-3/image";
const PRICE_PER_CALL = 0.005;

/**
 * The seven surfaces the product needs, with the prompt style each endpoint
 * wants.
 *
 * evf-sam takes REFERRING EXPRESSIONS, not bare nouns — "the floor surface of
 * the room" rather than "floor". sam-3 is a detector and prefers the plain noun
 * phrase. Both are recorded so the spike reports which style works where.
 */
type Target = {
  /** Surface kind, as it will be stored in `surfaces.kind`. */
  kind: string;
  /** Referring expression for evf-sam. */
  referring: string;
  /** Noun phrase for sam-3. */
  noun: string;
  /** Which endpoints to try. Architecture -> evf-sam; objects -> sam-3. */
  endpoints: Array<"evf" | "sam3">;
  /** Several instances expected, to be unioned (cabinet doors, windows). */
  multi?: boolean;
};

const TARGETS: Target[] = [
  { kind: "floor", referring: "the floor surface of the room", noun: "floor", endpoints: ["evf", "sam3"] },
  { kind: "wall", referring: "the painted wall surfaces of the room", noun: "wall", endpoints: ["evf", "sam3"] },
  { kind: "ceiling", referring: "the ceiling of the room", noun: "ceiling", endpoints: ["evf"] },
  {
    kind: "countertop",
    referring: "the kitchen countertop work surface",
    noun: "countertop",
    endpoints: ["evf", "sam3"],
  },
  {
    kind: "backsplash",
    referring: "the tiled backsplash wall behind the countertop",
    noun: "backsplash",
    endpoints: ["evf"],
  },
  {
    kind: "cupboard",
    referring: "the upper kitchen wall cabinets",
    noun: "kitchen cabinet",
    endpoints: ["evf", "sam3"],
    multi: true,
  },
  { kind: "window", referring: "the windows", noun: "window", endpoints: ["sam3"], multi: true },
];

type Attempt = {
  target: string;
  endpoint: string;
  prompt: string;
  ok: boolean;
  usable: boolean;
  note: string;
  stats?: MaskStats;
  ms: number;
  maskCount?: number;
  scores?: number[];
  requestId?: string;
  overlayKey?: string;
  error?: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** evf-sam returns a single mask file. */
type EvfOutput = { image?: { url: string }; mask?: { url: string }; url?: string };

/** sam-3 returns masks[] plus optional scores[]/boxes[]. */
type Sam3Output = {
  masks: Array<{ url: string; width?: number; height?: number }>;
  scores?: number[];
  boxes?: number[][];
};

async function main() {
  const imagePath = arg("image");
  const dry = has("dry");
  const limit = Number(arg("limit") ?? "0") || Infinity;

  const planned = TARGETS.flatMap((t) => t.endpoints.map((e) => ({ t, e })));
  const calls = Math.min(planned.length, limit);

  console.log("\nPHASE 3.5 — fal segmentation spike\n");
  console.log(`  targets:  ${TARGETS.length}`);
  console.log(`  calls:    ${calls}  (${planned.length} planned${limit < Infinity ? `, capped at ${limit}` : ""})`);
  console.log(`  estimate: $${(calls * PRICE_PER_CALL).toFixed(3)} at $${PRICE_PER_CALL}/call\n`);

  for (const { t, e } of planned.slice(0, calls)) {
    const ep = e === "evf" ? EVF_SAM : SAM3;
    const prompt = e === "evf" ? t.referring : t.noun;
    console.log(`  ${t.kind.padEnd(11)} ${ep.padEnd(18)} "${prompt}"`);
  }

  if (dry) {
    console.log("\n--dry: nothing submitted, nothing spent.\n");
    return;
  }

  if (!imagePath) {
    throw new Error(
      "No --image given.\n\n" +
        "This spike needs a REAL photograph of a kitchen or bathroom — a wide shot\n" +
        "showing floor, walls, cabinets and a countertop. Synthetic gradients prove\n" +
        "nothing about whether a segmenter resolves 'the countertop'.\n\n" +
        "  npx tsx scripts/spike-segment.ts --image C:/path/to/kitchen.jpg\n",
    );
  }

  const original = await readFile(path.resolve(imagePath));
  const meta = await sharp(original).metadata();
  if (!meta.width || !meta.height) throw new Error(`${imagePath} has no dimensions`);
  console.log(`\nimage: ${imagePath}  ${meta.width}x${meta.height}  ${(original.length / 1e6).toFixed(1)}MB`);

  /**
   * Segment at display scale, not full resolution.
   *
   * Masks are reused across every material trial, and a mask is only ever
   * consumed at display size or scaled from it. Sending 12MP would raise the
   * bill and the latency for a boundary no more accurate than the segmenter's
   * own precision.
   */
  const prepared = await sharp(original)
    .rotate()
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const pm = await sharp(prepared).metadata();
  console.log(`sent as: ${pm.width}x${pm.height}  ${(prepared.length / 1e3).toFixed(0)}KB`);
  console.log(`billable: ${fal.billableUnits(pm.width!, pm.height!)} megapixel unit(s) per call\n`);

  const imageUrl = await fal.upload(prepared, "spike-room.jpg", "image/jpeg");
  console.log(`uploaded to fal: ${imageUrl.slice(0, 72)}...\n`);

  const attempts: Attempt[] = [];
  let spent = 0;

  for (const { t, e } of planned.slice(0, calls)) {
    const endpoint = e === "evf" ? EVF_SAM : SAM3;
    const prompt = e === "evf" ? t.referring : t.noun;
    const label = `${t.kind}/${e}`;
    const started = Date.now();
    process.stdout.write(`  ${label.padEnd(20)} `);

    try {
      const input =
        e === "evf"
          ? {
              image_url: imageUrl,
              prompt,
              // Semantic level is what covers "stuff" classes (floor, wall)
              // rather than countable instances.
              semantic_type: true,
              fill_holes: true,
              mask_only: true,
            }
          : {
              image_url: imageUrl,
              prompt,
              // Without this you get the mask PAINTED ONTO the photo, which is
              // useless as a mask and easy to mistake for success.
              apply_mask: false,
              include_scores: true,
              include_boxes: true,
              ...(t.multi ? { return_multiple_masks: true, max_masks: 8 } : {}),
            };

      const { requestId, data } = await fal.run<EvfOutput | Sam3Output>(endpoint, input, {
        timeoutMs: 180_000,
      });
      spent += PRICE_PER_CALL;

      const urls: string[] = [];
      let scores: number[] | undefined;
      if (e === "evf") {
        const d = data as EvfOutput;
        const u = d.mask?.url ?? d.image?.url ?? d.url;
        if (u) urls.push(u);
      } else {
        const d = data as Sam3Output;
        for (const m of d.masks ?? []) urls.push(m.url);
        scores = d.scores;
      }

      if (urls.length === 0) {
        attempts.push({
          target: t.kind,
          endpoint: e,
          prompt,
          ok: true,
          usable: false,
          note: "no mask in response",
          ms: Date.now() - started,
          requestId,
          error: JSON.stringify(data).slice(0, 300),
        });
        console.log("no mask returned");
        continue;
      }

      const decoded: Mask[] = [];
      for (const u of urls) {
        const raw = await fal.download(u);
        let m = await decodeMask(raw);
        // Masks must be comparable to the photo and to each other.
        if (m.width !== pm.width || m.height !== pm.height) {
          m = await resizeMask(m, pm.width!, pm.height!);
        }
        decoded.push(m);
      }

      // "Cupboards" arrive as N separate doors; the product needs one surface.
      let mask = decoded.length > 1 ? union(decoded) : decoded[0];
      mask = await cleanMask(mask, 3);
      if (!t.multi) mask = largestComponent(mask);

      const stats = analyzeMask(mask);
      const verdict = judgeMask(t.kind, stats);

      const base = `spike/${t.kind}-${e}`;
      await storage.put(`${base}.png`, await encodeMask(mask));
      const overlayKey = `${base}-overlay.jpg`;
      await storage.put(overlayKey, await overlay(prepared, mask, tint(t.kind)));

      attempts.push({
        target: t.kind,
        endpoint: e,
        prompt,
        ok: true,
        usable: verdict.usable,
        note: verdict.note,
        stats,
        ms: Date.now() - started,
        maskCount: decoded.length,
        scores,
        requestId,
        overlayKey,
      });

      console.log(
        `${verdict.usable ? "USABLE " : "unusable"} cov ${(stats.coverage * 100).toFixed(1)}% ` +
          `comp ${stats.components} ${decoded.length > 1 ? `(${decoded.length} masks) ` : ""}` +
          `${(Date.now() - started) / 1000}s — ${verdict.note}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      attempts.push({
        target: t.kind,
        endpoint: e,
        prompt,
        ok: false,
        usable: false,
        note: "call failed",
        ms: Date.now() - started,
        error: message,
      });
      console.log(`ERROR ${message.slice(0, 140)}`);
    }
  }

  await writeReport(attempts, { imagePath, width: pm.width!, height: pm.height!, spent });

  const usable = attempts.filter((a) => a.usable);
  console.log(`\n  spent: $${spent.toFixed(3)}`);
  console.log(`  usable: ${usable.length}/${attempts.length}`);
  console.log(`  report: storage/spike/results.md`);
  console.log(`  overlays: storage/spike/*-overlay.jpg  <- LOOK AT THESE\n`);

  // The numbers cannot tell you a mask is on the right OBJECT. A wall mask and a
  // floor mask of equal size and position score identically.
  console.log("  Numbers only prove a mask is well-formed. Open the overlays to");
  console.log("  confirm each one is on the surface it claims.\n");
}

function tint(kind: string): [number, number, number] {
  switch (kind) {
    case "floor":
      return [39, 76, 62]; // pine
    case "wall":
      return [169, 131, 79]; // brass
    case "ceiling":
      return [80, 120, 200];
    case "countertop":
      return [200, 60, 90];
    case "backsplash":
      return [220, 150, 40];
    case "cupboard":
      return [120, 60, 190];
    default:
      return [40, 190, 190];
  }
}

async function writeReport(
  attempts: Attempt[],
  ctx: { imagePath: string; width: number; height: number; spent: number },
) {
  const rows = attempts
    .map((a) => {
      const s = a.stats;
      return (
        `| ${a.target} | ${a.endpoint} | \`${a.prompt}\` | ${a.usable ? "**yes**" : "no"} | ` +
        `${s ? (s.coverage * 100).toFixed(1) + "%" : "—"} | ${s ? s.components : "—"} | ` +
        `${a.maskCount ?? "—"} | ${s ? s.centroid.y.toFixed(2) : "—"} | ${(a.ms / 1000).toFixed(1)}s | ` +
        `${a.note}${a.error ? ` — \`${a.error.slice(0, 80)}\`` : ""} |`
      );
    })
    .join("\n");

  const byTarget = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = byTarget.get(a.target) ?? [];
    list.push(a);
    byTarget.set(a.target, list);
  }
  const verdicts = [...byTarget.entries()]
    .map(([kind, list]) => {
      const winners = list.filter((a) => a.usable);
      if (winners.length === 0) return `- **${kind}** — NOTHING WORKED. Needs brush correction or another approach.`;
      const best = winners.sort((a, b) => (b.stats?.largestShare ?? 0) - (a.stats?.largestShare ?? 0))[0];
      return `- **${kind}** — use \`${best.endpoint === "evf" ? EVF_SAM : SAM3}\` with \`${best.prompt}\``;
    })
    .join("\n");

  const md = `# Phase 3.5 — segmentation spike results

Image: \`${ctx.imagePath}\` sent at ${ctx.width}x${ctx.height}
Spent: **$${ctx.spent.toFixed(3)}**
Usable: **${attempts.filter((a) => a.usable).length}/${attempts.length}**

## What this answers

Whether fal's promptable segmenters resolve architectural surfaces ("the floor",
"the countertop") and not just the discrete objects in their docs. Phases 4-7
assume they do.

"Usable" is a measurement, not an impression — see \`judgeMask\` in lib/mask.ts.
A mask fails if it is empty, grabs the whole frame, is speckle, or sits in a
position the surface cannot occupy (a "floor" that never reaches the bottom edge).

**A usable verdict does not mean the mask is on the right object.** Coverage and
position cannot distinguish a wall from a floor of the same size. Check the
overlays.

## Results

| surface | endpoint | prompt | usable | coverage | components | masks | centroid y | time | note |
|---|---|---|---|---|---|---|---|---|---|
${rows}

## Recommended per surface

${verdicts}

## Overlays

${attempts
  .filter((a) => a.overlayKey)
  .map((a) => `- ${a.target}/${a.endpoint}: \`storage/${a.overlayKey}\``)
  .join("\n")}
`;

  await storage.put("spike/results.md", Buffer.from(md, "utf8"));
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
