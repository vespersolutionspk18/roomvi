/**
 * Ad-hoc state inspector: `npm run peek`.
 *
 * What is in the database and can it render? Answers the three questions asked
 * before every manual test — is there a photo, is it analyzed, and is there a
 * material with a real texture bitmap to render FROM. A material with no texture
 * is refused by the route, so listing them without that column is misleading.
 */
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { images, materials, renderOps, renders, surfaces } from "../lib/db/schema";

async function main() {
  const imageRows = await db.select().from(images).orderBy(desc(images.createdAt));
  console.log(`\n=== images (${imageRows.length}) ===`);
  for (const r of imageRows) {
    const zones = await db.select().from(surfaces).where(eq(surfaces.imageId, r.id));
    console.log(
      `${r.id}  ${r.displayWidth}x${r.displayHeight}  ` +
        `${r.analyzedAt ? `analyzed ${r.analyzedAt.toISOString().slice(0, 16)}` : "NOT analyzed"}  ` +
        `${zones.length} zone(s)`,
    );
    for (const z of zones) {
      console.log(`    ${z.kind.padEnd(16)} ${z.source.padEnd(6)} conf ${z.confidence ?? "—"}`);
    }
  }

  const materialRows = await db.select().from(materials);
  const renderable = materialRows.filter((m) => m.textureKey && m.active);
  console.log(`\n=== materials (${materialRows.length}, ${renderable.length} renderable) ===`);
  for (const m of materialRows) {
    console.log(
      `${m.id}  ${m.sku.padEnd(14)} ${m.category.padEnd(11)} ${m.name.padEnd(26)} ` +
        `texture ${m.textureKey ? "yes" : "NO "}  ` +
        `${m.tileWMm ? `${m.tileWMm}x${m.tileHMm}mm` : "no mm"}  ` +
        `${m.precisionReady ? "precision" : ""}`,
    );
  }

  const renderRows = await db.select().from(renders).orderBy(desc(renders.createdAt)).limit(12);
  console.log(`\n=== renders (latest ${renderRows.length}) ===`);
  for (const r of renderRows) {
    const ops = await db.select().from(renderOps).where(eq(renderOps.renderId, r.id));
    console.log(
      `${r.id}  ${r.status.padEnd(9)} ${r.executor.padEnd(10)} ` +
        `${r.costUnits ?? "—"} unit  drift ${r.driftScore?.toFixed(2) ?? "—"}  ` +
        `${r.outputKey ?? "no output"}`,
    );
    for (const o of ops) {
      console.log(`    ${o.kind} surface=${o.surfaceId ?? "—"} material=${o.materialId ?? "—"} ${o.prompt ?? ""}`);
    }
    if (r.errorMessage) console.log(`    ERROR: ${r.errorMessage}`);
  }
  console.log();
}

main()
  .catch(console.error)
  .finally(() => pool.end());
