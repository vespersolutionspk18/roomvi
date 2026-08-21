/**
 * Phase 4 end-to-end: upload -> enqueue -> worker -> surfaces rows -> API shape.
 *
 * Distinct from test-analyze.ts, which drives the pipeline directly. This one
 * exercises everything AROUND it — the parts that can be wrong while the
 * segmentation is perfectly right:
 *
 *   - the analyze job's idempotency guard (does a second enqueue re-buy 7 masks?)
 *   - the `analyzedAt` short-circuit (does a re-run of a done job cost money?)
 *   - brush-surface preservation across a re-analyze (does it destroy user work?)
 *   - mask files actually existing at the keys the rows advertise
 *
 * COST: reuses whatever analyze already ran for this image where possible. A
 * fresh image costs ~$0.035; the idempotency and preservation checks are free
 * because their whole point is that they must NOT trigger fal calls.
 *
 * Requires a running worker (`npm run worker`) in another terminal.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { images, jobs, projects, surfaces, users } from "../lib/db/schema";
import { prepareUpload } from "../lib/image";
import { encodeMask } from "../lib/mask";
import { enqueue } from "../lib/queue";
import * as storage from "../lib/storage";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the worker to finish an analyze job, or give up loudly. */
async function waitForJob(jobId: string, timeoutMs = 240_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (!job) throw new Error(`job ${jobId} vanished`);
    if (job.status !== last) {
      console.log(`       job ${job.status}${job.attempts ? ` (attempt ${job.attempts})` : ""}`);
      last = job.status;
    }
    if (job.status === "done") return "done";
    if (job.status === "dead") {
      throw new Error(`job dead-lettered: ${job.lastError}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `job still ${job.status} after ${timeoutMs / 1000}s — is the worker running? (npm run worker)`,
      );
    }
    await sleep(1500);
  }
}

async function main() {
  const imagePath = process.argv.includes("--image")
    ? process.argv[process.argv.indexOf("--image") + 1]
    : "fixtures/kitchen-real.jpg";

  console.log("\nPHASE 4 end-to-end — upload, worker, surfaces, API shape\n");

  // A worker must be running or this test measures nothing.
  const before = await db.query.jobs.findMany({ where: eq(jobs.status, "running") });
  console.log(`  ${before.length} job(s) currently running\n`);

  /* -------------------------------------------------- fixture project & image */

  let [user] = await db.select().from(users).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({ email: "phase4@test.local", passwordHash: "x" })
      .returning();
  }
  const [project] = await db
    .insert(projects)
    .values({ userId: user.id, name: "Phase 4 — analyze e2e" })
    .returning();

  const raw = await readFile(path.resolve(imagePath));
  const prepared = await prepareUpload(raw);

  const [image] = await db
    .insert(images)
    .values({
      projectId: project.id,
      storageKey: "",
      width: prepared.width,
      height: prepared.height,
      displayWidth: prepared.displayWidth,
      displayHeight: prepared.displayHeight,
      // Suffixed so a re-run of this test is a genuinely new image rather than
      // hitting the upload route's dedupe.
      sha256: `e2e${Date.now()}`.padEnd(64, "0").slice(0, 64),
      mimeType: prepared.originalMime,
      byteSize: prepared.original.byteLength,
    })
    .returning();

  const displayKey = storage.keys.imageDisplay(image.id);
  await storage.put(displayKey, prepared.display);
  await storage.put(storage.keys.imageOriginal(image.id, prepared.originalExt), prepared.original);
  await db.update(images).set({ displayKey }).where(eq(images.id, image.id));
  console.log(`  image ${image.id}  ${prepared.displayWidth}x${prepared.displayHeight}\n`);

  /* ----------------------------------------------------------- 1. idempotency */

  console.log("1. a double-click must not buy two sets of masks");
  const first = await enqueue({
    kind: "analyze",
    payload: { imageId: image.id },
    priority: 5,
    idempotencyKey: `analyze:${image.id}`,
  });
  const second = await enqueue({
    kind: "analyze",
    payload: { imageId: image.id },
    priority: 5,
    idempotencyKey: `analyze:${image.id}`,
  });
  check("first enqueue created a job", first.created);
  check("second enqueue did NOT create a job", !second.created);
  check("...and returned the same job", first.job.id === second.job.id);

  /* ------------------------------------------------------- 2. the worker runs */

  console.log("\n2. the worker segments and persists");
  console.log(`       waiting on job ${first.job.id} (7 fal calls, ~60s)`);
  await waitForJob(first.job.id);

  const rows = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, image.id) });
  check(`persisted ${rows.length} surfaces`, rows.length === 7, String(rows.length));

  const img = await db.query.images.findFirst({ where: eq(images.id, image.id) });
  check("analyzedAt was stamped", img?.analyzedAt != null);

  // Every advertised mask must exist. A row pointing at a missing file breaks the
  // editor in a way that looks like a segmentation bug.
  let allPresent = true;
  for (const s of rows) {
    if (!(await storage.exists(s.maskKey))) {
      allPresent = false;
      console.log(`       missing mask file: ${s.maskKey}`);
    }
  }
  check("every surface's mask file exists on disk", allPresent);

  check(
    "every surface has a normalized bbox",
    rows.every((s) => Array.isArray(s.bbox) && s.bbox.length === 4),
  );
  check(
    "area estimates are stored as ranges",
    rows.every((s) => s.areaM2Low == null || (s.areaM2High != null && s.areaM2Low < s.areaM2High)),
  );
  check(
    "all seven expected kinds are present",
    ["floor", "wall", "ceiling", "countertop", "backsplash", "upper_cabinets", "window"].every((k) =>
      rows.some((s) => s.kind === k),
    ),
    rows.map((s) => s.kind).join(","),
  );

  /* ------------------------------------------- 3. re-running must not re-spend */

  console.log("\n3. re-running an analyzed image must be free");
  const rerun = await enqueue({
    kind: "analyze",
    payload: { imageId: image.id },
    priority: 5,
    // A distinct key, so this is a genuinely new job and only `analyzedAt` can
    // stop it from spending money.
    idempotencyKey: `analyze:${image.id}:rerun`,
  });
  const startedAt = Date.now();
  await waitForJob(rerun.job.id, 60_000);
  const elapsed = Date.now() - startedAt;
  check(
    `completed in ${(elapsed / 1000).toFixed(1)}s — too fast to have called fal`,
    elapsed < 20_000,
    `${(elapsed / 1000).toFixed(1)}s`,
  );

  const afterRerun = await db.query.surfaces.findMany({ where: eq(surfaces.imageId, image.id) });
  check("surface count unchanged by the skipped re-run", afterRerun.length === rows.length);
  check(
    "surface ids unchanged — masks were not rewritten",
    afterRerun.every((s) => rows.some((r) => r.id === s.id)),
  );

  /* ----------------------------- 4. a forced re-analyze preserves brush work */

  console.log("\n4. a forced re-analyze must not destroy the user's brush edits");
  const brushMask = { data: new Uint8Array(prepared.displayWidth * prepared.displayHeight), width: prepared.displayWidth, height: prepared.displayHeight };
  brushMask.data.fill(255, 0, brushMask.data.length / 4);
  const [brushed] = await db
    .insert(surfaces)
    .values({
      imageId: image.id,
      kind: "custom",
      label: "Hand-drawn zone",
      maskKey: "placeholder",
      source: "brush",
    })
    .returning();
  const brushKey = storage.keys.surfaceMask(brushed.id);
  await storage.put(brushKey, await encodeMask(brushMask));
  await db.update(surfaces).set({ maskKey: brushKey }).where(eq(surfaces.id, brushed.id));

  const forced = await enqueue({
    kind: "analyze",
    payload: { imageId: image.id, force: true },
    priority: 5,
    idempotencyKey: `analyze:${image.id}:force:${Date.now()}`,
  });
  console.log(`       waiting on forced job ${forced.job.id} (spends ~$0.035)`);
  await waitForJob(forced.job.id);

  const survivor = await db.query.surfaces.findFirst({ where: eq(surfaces.id, brushed.id) });
  check("the brush surface survived a forced re-analyze", survivor != null);
  check("...and still points at its own mask", survivor?.maskKey === brushKey);

  const falRows = await db.query.surfaces.findMany({
    where: and(eq(surfaces.imageId, image.id), eq(surfaces.source, "fal")),
  });
  check(
    `fal surfaces replaced, not duplicated (${falRows.length})`,
    falRows.length === 7,
    String(falRows.length),
  );
  check(
    "the replaced fal surfaces have NEW ids",
    falRows.every((s) => !rows.some((r) => r.id === s.id)),
  );

  // The old masks are now orphaned files. Worth knowing rather than assuming.
  const orphaned = [];
  for (const old of rows) {
    if (await storage.exists(old.maskKey)) orphaned.push(old.maskKey);
  }
  console.log(
    `       note: ${orphaned.length} orphaned mask file(s) from the previous run ` +
      `— harmless, but a cleanup job's worth of garbage`,
  );

  console.log(`\n  cleanup: dropping project ${project.id}`);
  await db.delete(projects).where(eq(projects.id, project.id));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`spent: ~$0.070 (two real analyze runs)\n`);
  process.exitCode = failed > 0 ? 1 : 0;
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\n${err instanceof Error ? err.stack : err}\n`);
  process.exitCode = 1;
  await pool.end();
});
