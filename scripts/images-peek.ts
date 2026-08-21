/** Ad-hoc image inspector: `npx tsx scripts/images-peek.ts` */
import { db, pool } from "../lib/db";
import { images } from "../lib/db/schema";

async function main() {
  const rows = await db.select().from(images);
  if (rows.length === 0) console.log("no images");
  for (const r of rows) {
    console.log(
      `${r.id}  ${r.width}x${r.height}  display ${r.displayWidth}x${r.displayHeight}  ${r.storageKey}`,
    );
    console.log(`    quality: ${JSON.stringify(r.quality)}`);
  }
}

main()
  .catch(console.error)
  .finally(() => pool.end());
