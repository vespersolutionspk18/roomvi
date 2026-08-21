/**
 * Did the render actually change the masked region?
 *
 * `npx tsx scripts/render-diff.ts <renderId>`
 *
 * The structure guard answers "did anything change OUTSIDE the mask", which on a
 * composited render is 0 by construction — the composite is what makes it 0. The
 * complementary question is the one that tells you the render WORKED, and nothing
 * measured it until now: how much changed INSIDE the mask. A generative render
 * that returns the photo unchanged is a silent, paid no-op.
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db, pool } from "../lib/db";
import { renderOps, renders, surfaces } from "../lib/db/schema";
import { decodeMask, resizeMask } from "../lib/mask";
import * as storage from "../lib/storage";
import { images } from "../lib/db/schema";

async function main() {
  const renderId = process.argv[2];
  if (!renderId) throw new Error("usage: render-diff.ts <renderId>");

  const row = await db.query.renders.findFirst({ where: eq(renders.id, renderId) });
  if (!row?.outputKey) throw new Error(`render ${renderId} has no output`);
  const image = await db.query.images.findFirst({ where: eq(images.id, row.baseImageId) });
  if (!image?.displayKey) throw new Error("no display copy");

  const ops = await db.select().from(renderOps).where(eq(renderOps.renderId, renderId));
  const surfaceId = ops.find((o) => o.surfaceId)?.surfaceId;
  if (!surfaceId) throw new Error("no masked op");
  const surface = await db.query.surfaces.findFirst({ where: eq(surfaces.id, surfaceId) });
  if (!surface) throw new Error("surface gone");

  const before = await storage.get(image.displayKey);
  const after = await storage.get(row.outputKey);
  const meta = await sharp(before).metadata();
  const W = meta.width!;
  const H = meta.height!;

  const mask = await resizeMask(await decodeMask(await storage.get(surface.maskKey)), W, H);

  const raw = (b: Buffer) => sharp(b).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const [a, c] = await Promise.all([raw(before), raw(after)]);

  let inSum = 0, inN = 0, outSum = 0, outN = 0, inMax = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 3;
    const d = (Math.abs(a[p] - c[p]) + Math.abs(a[p + 1] - c[p + 1]) + Math.abs(a[p + 2] - c[p + 2])) / 3;
    if (mask.data[i]) {
      inSum += d; inN++; if (d > inMax) inMax = d;
    } else {
      outSum += d; outN++;
    }
  }

  const inside = inN ? inSum / inN : 0;
  const outside = outN ? outSum / outN : 0;
  console.log(`mask covers ${((inN / (W * H)) * 100).toFixed(1)}% of the frame (${inN} px)`);
  console.log(`mean |diff| INSIDE  mask: ${inside.toFixed(2)}  (max ${inMax.toFixed(0)})`);
  console.log(`mean |diff| OUTSIDE mask: ${outside.toFixed(2)}`);
  console.log(
    inside < 2
      ? "\nVERDICT: the render barely touched the masked region — a paid no-op."
      : `\nVERDICT: the masked region changed (${(inside / Math.max(outside, 0.01)).toFixed(0)}x the outside).`,
  );

  // A crop of just the masked bbox, before and after, side by side. Numbers say
  // "it changed"; only the crop says whether it changed into the right thing.
  const b = surface.bbox as [number, number, number, number] | null;
  if (b) {
    const left = Math.floor(b[0] * W), top = Math.floor(b[1] * H);
    const width = Math.max(8, Math.floor((b[2] - b[0]) * W));
    const height = Math.max(8, Math.floor((b[3] - b[1]) * H));
    const crop = (buf: Buffer) =>
      sharp(buf).resize(W, H, { fit: "fill" }).extract({ left, top, width, height }).png().toBuffer();
    const [cb, ca] = await Promise.all([crop(before), crop(after)]);
    const out = await sharp({
      create: { width: width * 2 + 12, height, channels: 3, background: "#191917" },
    })
      .composite([{ input: cb, left: 0, top: 0 }, { input: ca, left: width + 12, top: 0 }])
      .png()
      .toBuffer();
    writeFileSync(`storage/tmp/diff-${renderId}.png`, out);
    console.log(`\nwrote storage/tmp/diff-${renderId}.png (before | after, masked region only)`);
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
