/**
 * Crash-recovery test: hard-kill a worker holding a job, prove the job is
 * neither lost nor re-run more times than its attempt budget allows.
 *
 * This cannot be tested through `lib/queue.ts` alone. The failure mode is a
 * process dying without running ANY cleanup — no finally block, no signal
 * handler, no connection close — so it needs a real OS process and a real hard
 * kill (`taskkill /F` on Windows, SIGKILL elsewhere). `test-queue.ts` proves the
 * reap SQL by mutating `lease_expires_at`; this proves the situation that SQL
 * exists for actually arises and is recovered from.
 *
 * Run with: npx tsx scripts/test-crash.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { jobs } from "../lib/db/schema";
import { LEASE_MS, REAP_EVERY_MS, reap } from "../lib/queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function hardKill(pid: number) {
  if (process.platform === "win32") {
    // /T takes the child tree too: `npm run worker` is npm -> tsx -> node, and
    // killing only npm would leave the actual worker alive still holding leases.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * Start a real worker process.
 *
 * Runs `worker/index.ts` directly rather than via `npm run worker`, for two
 * reasons: `npm` is a .cmd shim on Windows and cannot be spawned without a
 * shell, and the npm script uses `tsx watch`, whose restart-on-change behaviour
 * has no place in a test.
 */
function startWorker() {
  return spawn(
    process.execPath,
    ["--import", "tsx", "--env-file-if-exists=.env.local", "worker/index.ts"],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Wait for a job to reach a terminal state, or give up. */
async function waitFor(jobId: string, want: Array<string>, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (row && want.includes(row.status)) return row;
    await sleep(250);
  }
  return db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
}

/** A worker that claims a job and then hangs forever, holding the lease.
 *
 *  Deliberately not the real worker killed at a guessed instant: a mipmap
 *  finishes in ~90ms, so racing `taskkill` against it would be flaky and would
 *  prove nothing about the lease. Hanging after the claim is precisely the state
 *  a worker is in when it dies waiting on a 4-minute fal poll. */
async function claimAndHang(kinds: string): Promise<{ pid: number; jobId: string | null }> {
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      // A bare `node` does not inherit Next's .env.local convention, so without
      // this it would have no DATABASE_URL.
      "--env-file-if-exists=.env.local",
      "--input-type=module",
      "-e",
      `
      import { claim } from ${JSON.stringify(new URL("../lib/queue.ts", import.meta.url).href)};
      const j = await claim("victim-worker", ${JSON.stringify(kinds)}.split(","));
      console.log("CLAIMED:" + (j ? j.id : "none"));
      await new Promise(() => {});   // hold the lease, never renew, never release
      `,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );

  let jobId: string | null = null;
  proc.stdout.on("data", (d: Buffer) => {
    const m = /CLAIMED:(\S+)/.exec(d.toString());
    if (m) jobId = m[1] === "none" ? null : m[1];
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`  [victim] ${d}`));

  for (let i = 0; i < 80 && jobId === null; i++) await sleep(250);
  return { pid: proc.pid!, jobId };
}

/**
 * Refuse to run if anything else could claim these jobs.
 *
 * Learned the hard way: `npm run worker` uses `tsx watch`, which RESTARTS the
 * child after a hard kill. A stray worker silently claimed this test's jobs and
 * turned real assertions into false passes — the survivor's log was empty
 * because there was nothing left for it to do. A visible bail beats a green run
 * that tested nothing.
 */
async function assertNoCompetition(): Promise<void> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  if (n > 0) {
    throw new Error(
      `${n} queued/running job(s) already present. Another worker may be alive and would\n` +
        `claim this test's jobs. Stop it (Windows: taskkill /PID <npm-pid> /T /F — the /T\n` +
        `matters, tsx watch respawns the child otherwise) and clear the queue:\n` +
        `  delete from jobs where status in ('queued','running');`,
    );
  }
}

async function main() {
  await assertNoCompetition();

  console.log("\n1. hard-kill a worker mid-job; reap reclaims it\n");

  const jobId = `crash-${Date.now()}`;
  await db.insert(jobs).values({
    id: jobId,
    kind: "mipmap",
    payload: { sku: "CAR-MST-600", crashTest: true },
    maxAttempts: 3,
  });

  const victim = await claimAndHang("mipmap");
  check("victim claimed the job", victim.jobId === jobId, `claimed ${victim.jobId}`);

  const held = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  check("running, with a lease", held?.status === "running" && held.leaseExpiresAt != null);
  check("attempts incremented at claim", held?.attempts === 1);

  console.log(`\nhard-killing victim (pid ${victim.pid}) — no cleanup will run`);
  hardKill(victim.pid);
  await sleep(1_500);

  const orphaned = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  check("job STRANDED as running (this is what the lease exists for)", orphaned?.status === "running");
  check("lease still live, so not yet reapable", (orphaned?.leaseExpiresAt?.getTime() ?? 0) > Date.now());
  check("reap refuses to steal a live lease", (await reap()) === 0);

  // Skipping the wait rather than sleeping LEASE_MS; comparing against now() is
  // already covered by test-queue.
  console.log(`\nexpiring the lease (a real crash would wait ${LEASE_MS / 1000}s)`);
  await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(jobs.id, jobId));

  check("reap reclaims the dead worker's job", (await reap()) >= 1);

  const recovered = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  check("queued again — the job was not lost", recovered?.status === "queued");
  check("lock released", recovered?.lockedBy === null && recovered.leaseExpiresAt === null);
  check(
    "attempts NOT reset, so a job that kills its worker cannot loop forever",
    recovered?.attempts === 1,
  );
  check("crash reason recorded", recovered?.lastError?.includes("lease expired") === true);

  /**
   * Step 1 called `reap()` from the test process, which leaves the real recovery
   * path unproven: nothing showed that the WORKER'S reaper interval fires, or
   * that it wakes the claim loop afterwards instead of waiting out another poll.
   *
   * So strand a second job now, BEFORE any worker is running, and leave its
   * lease LIVE. A running job with an unexpired lease is not claimable, so the
   * survivor cannot take it by ordinary means — the only way it can ever run is
   * if the worker reaps it itself.
   */
  console.log("\n2. the worker's OWN reaper recovers a stranded job, unassisted\n");

  const jobId2 = `crash2-${Date.now()}`;
  await db.insert(jobs).values({
    id: jobId2,
    kind: "render",
    payload: { crashTest: true },
    maxAttempts: 3,
  });

  const victim2 = await claimAndHang("render");
  check("second victim claimed it", victim2.jobId === jobId2, `claimed ${victim2.jobId}`);
  hardKill(victim2.pid);
  await sleep(1_000);

  const stranded = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId2) });
  check("stranded running, lease still live", stranded?.status === "running");

  console.log("starting a survivor worker\n");
  const survivor = startWorker();
  let log = "";
  const collect = (d: Buffer) => {
    log += d.toString();
  };
  survivor.stdout.on("data", collect);
  survivor.stderr.on("data", (d: Buffer) => {
    collect(d);
    process.stderr.write(`  [survivor] ${d}`);
  });

  const final = await waitFor(jobId, ["done", "dead"], 25_000);
  check("survivor completes job 1, reclaimed earlier", final?.status === "done", `status ${final?.status}`);
  check("attempts = 2 (one crashed, one succeeded) — no runaway", final?.attempts === 2, `${final?.attempts}`);

  const untouched = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId2) });
  check("survivor did NOT claim job 2 while its lease was live", untouched?.status === "running");
  check("...and did not steal the lock", untouched?.lockedBy === "victim-worker", String(untouched?.lockedBy));

  // Skipping ahead rather than sleeping out the lease; what is under test is the
  // worker's reaper, not Postgres' clock.
  console.log("expiring job 2's lease, then leaving the worker entirely alone");
  await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(jobs.id, jobId2));

  console.log(`  waiting up to ${REAP_EVERY_MS / 1000}s for its reaper sweep...`);
  const auto = await waitFor(jobId2, ["done", "dead"], REAP_EVERY_MS + 20_000);

  // `render` is a PermanentError placeholder until Phase 5, so 'dead' is the
  // correct terminal state — reaching it proves the reaper handed the job to a
  // handler, which is the part being tested.
  check("worker reaped it with no external reap() call", auto?.status === "dead", `status ${auto?.status}`);
  // The status change is written before the log line, so give the pipe a moment
  // rather than racing it.
  await sleep(1_000);
  check("reaper logged the reclaim", /\[reap\] reclaimed \d+ job/.test(log), `log was:\n${log}`);
  check("attempts = 2, still bounded", auto?.attempts === 2, `${auto?.attempts}`);

  hardKill(survivor.pid!);
  for (const l of log.split("\n")) {
    if (l.includes(jobId) || l.includes(jobId2) || l.includes("[reap]")) console.log(`  survivor: ${l.trim()}`);
  }

  await db.delete(jobs).where(sql`${jobs.payload}->>'crashTest' = 'true'`);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
