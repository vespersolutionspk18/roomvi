/**
 * Recover a render whose work succeeded but whose bookkeeping failed.
 *
 * `npx tsx scripts/render-recover.ts <renderId>`
 *
 * There is a narrow, real window where a render is fully paid for, its output is
 * on disk, and the row still says `failed`: the success UPDATE threw. That is not
 * hypothetical — a `seed` of 2599281090 overflowed an `integer` column and did
 * exactly this, and the retry then paid twice more.
 *
 * The overflow is fixed (the column is `bigint`) and the retry is fixed (`execute`
 * re-polls a stored request id), but the row it left behind is still wrong, and
 * re-rendering it would be a fourth charge for an image already sitting on disk.
 * So: read the output that exists, re-derive the drift from it, and write the row.
 *
 * Refuses to touch a render that has no output file, because then there is nothing
 * to recover and the honest state is `failed`.
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
  if (!renderId) throw new Error("usage: render-recover.ts <renderId>");

  const row = await db.query.renders.findFirst({ where: eq(renders.id, renderId) });
  if (!row) throw new Error(`no render '${renderId}'`);
  if (row.status === "ready") {
    console.log(`${renderId} is already ready — nothing to recover`);
    return;
  }

  const key = storage.keys.renderOutput(renderId);
  let output: Buffer;
  try {
    output = await storage.get(key);
  } catch {
    throw new Error(
      `${renderId} has no output at '${key}' — the render did not finish, so 'failed' is correct`,
    );
  }
  console.log(`found ${output.length} bytes at ${key}`);

  const image = await db.query.images.findFirst({ where: eq(images.id, row.baseImageId) });
  if (!image?.displayKey || !image.displayWidth || !image.displayHeight) {
    throw new Error("base image has no display copy");
  }
  const meta = await sharp(output).metadata();

  /**
   * Drift is re-derived from the COMPOSITE, which understates it — the raw fal
   * output is long gone from local disk. Recorded anyway rather than left null,
   * because a null reads in the UI as "not measured" and this was measured; the
   * warning simply cannot fire for a recovered render. Noted here so nobody later
   * reads a suspiciously clean recovered score as evidence the model behaved.
   */
  const opRows = await db.select().from(renderOps).where(eq(renderOps.renderId, renderId));
  const maskKeys = new Set<string>();
  for (const op of opRows) {
    if (!op.surfaceId) continue;
    const s = await db.query.surfaces.findFirst({ where: eq(surfaces.id, op.surfaceId) });
    if (s) maskKeys.add(s.maskKey);
  }

  let drift: number | null = null;
  if (maskKeys.size > 0) {
    const masks: Mask[] = [];
    for (const k of maskKeys) masks.push(await decodeMask(await storage.get(k)));
    const mask = masks.length > 1 ? union(masks) : masks[0];
    const photo = await storage.get(image.displayKey);
    const report = await measureDrift(photo, output, await guardMask(mask, 12));
    drift = report.score;
    console.log(`drift on the composite: ${report.verdict} — ${report.detail}`);
  }

  const width = meta.width ?? image.displayWidth;
  const height = meta.height ?? image.displayHeight;

  await db
    .update(renders)
    .set({
      status: "ready",
      outputKey: key,
      width,
      height,
      /**
       * Re-derived from the dimensions by the same function that billed it, so the
       * reconciliation total stays right. `seed` is deliberately NOT invented: it
       * only ever existed in the UPDATE that threw, and a wrong seed is worse than
       * a null one because it claims the render is reproducible when it is not.
       */
      costUnits: fal.billableUnits(width, height),
      driftScore: drift,
      errorCode: null,
      errorMessage: null,
      completedAt: row.completedAt ?? new Date(),
    })
    .where(eq(renders.id, renderId));

  console.log(`\n${renderId} recovered as ready — no new fal charge`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
