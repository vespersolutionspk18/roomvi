/**
 * Re-measure a render's drift against fal's RAW output, and prove resume works.
 *
 * `npx tsx scripts/render-reguard.ts <renderId>`
 *
 * Two jobs, one free fal round-trip:
 *
 *  1. A render composited before the guard-ordering fix has a drift score measured
 *     on the COMPOSITE, which is 0 by construction — the composite restores those
 *     pixels. So does a render recovered by `render-recover.ts`, which has no raw
 *     output left to measure. Both store a number that reads as "the model behaved"
 *     when it is really "compositing worked". This re-derives the honest number.
 *
 *  2. It exercises the premise the whole resume path rests on: that fal keeps a
 *     completed result addressable by request id, indefinitely and for free. If that
 *     ever stops being true, `execute`'s retry-costs-nothing guarantee is void and
 *     this script is where it shows up first.
 *
 * Costs nothing. `fal.queue.result` on an already-completed request is a read.
 */
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db, pool } from "../lib/db";
import { images, renderOps, renders, surfaces } from "../lib/db/schema";
import * as fal from "../lib/fal";
import { decodeMask, union, type Mask } from "../lib/mask";
import { guardMask } from "../lib/render/composite";
import { measureDrift } from "../lib/render/guard";
import * as storage from "../lib/storage";

async function main() {
  const renderId = process.argv[2];
  if (!renderId) throw new Error("usage: render-reguard.ts <renderId>");

  const row = await db.query.renders.findFirst({ where: eq(renders.id, renderId) });
  if (!row) throw new Error(`no render '${renderId}'`);
  if (!row.falRequestId || !row.model) {
    throw new Error(`${renderId} has no stored fal request id — nothing to re-poll`);
  }

  const image = await db.query.images.findFirst({ where: eq(images.id, row.baseImageId) });
  if (!image?.displayKey || !image.displayWidth || !image.displayHeight) {
    throw new Error("base image has no display copy");
  }

  const opRows = await db.select().from(renderOps).where(eq(renderOps.renderId, renderId));
  const maskKeys = new Set<string>();
  for (const op of opRows) {
    if (!op.surfaceId) continue;
    const s = await db.query.surfaces.findFirst({ where: eq(surfaces.id, op.surfaceId) });
    if (s) maskKeys.add(s.maskKey);
  }
  if (maskKeys.size === 0) {
    throw new Error(`${renderId} has no masked ops — there is no untouched region to measure`);
  }

  console.log(`re-polling ${row.model} ${row.falRequestId} (free — already paid)`);
  const data = await fal.poll<{ images: Array<{ url: string }> }>(row.model, row.falRequestId, {
    timeoutMs: 60_000,
  });
  const url = data.images?.[0]?.url;
  if (!url) throw new Error("the stored request returned no image — fal may have expired it");
  const edited = await fal.download(url);
  console.log(`fal still has it: ${edited.length} bytes`);

  const masks: Mask[] = [];
  for (const k of maskKeys) masks.push(await decodeMask(await storage.get(k)));
  const mask = masks.length > 1 ? union(masks) : masks[0];
  const photo = await storage.get(image.displayKey);

  // Normalised to the photo's dimensions first, exactly as `execute` does: fal
  // returns at its own resolution and the mask is in display space.
  const normalised = await sharp(edited)
    .resize(image.displayWidth, image.displayHeight, { fit: "fill", kernel: "lanczos3" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  const raw = await measureDrift(photo, normalised, await guardMask(mask, 12));
  console.log(`\nstored drift:  ${row.driftScore?.toFixed(4) ?? "null"}`);
  console.log(`raw drift:     ${raw.score.toFixed(4)} — ${raw.verdict}`);
  console.log(`               ${raw.detail}`);

  if (row.driftScore != null && Math.abs(row.driftScore - raw.score) < 0.005) {
    console.log("\nalready measured on the raw output — nothing to correct");
    return;
  }
  await db.update(renders).set({ driftScore: raw.score }).where(eq(renders.id, renderId));
  console.log(`\n${renderId} drift corrected to the raw measurement`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
