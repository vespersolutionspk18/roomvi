/** Ad-hoc queue inspector: `npx tsx scripts/queue-peek.ts` */
import { desc } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { jobs } from "../lib/db/schema";
import { stats } from "../lib/queue";

async function main() {
  console.log("by status:", await stats());
  const rows = await db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      attempts: jobs.attempts,
      runAfter: jobs.runAfter,
      lockedBy: jobs.lockedBy,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(20);
  for (const r of rows) {
    console.log(
      `  ${r.status.padEnd(7)} ${r.kind.padEnd(7)} a=${r.attempts} ${r.id}` +
        `${r.lockedBy ? ` by ${r.lockedBy}` : ""}${r.lastError ? ` err=${r.lastError.slice(0, 60)}` : ""}`,
    );
  }
}

main()
  .catch(console.error)
  .finally(() => pool.end());
