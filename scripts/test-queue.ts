/**
 * Queue behaviour test. Run with `npx tsx scripts/test-queue.ts`.
 *
 * Not a unit test — it exercises the real database, because everything that can
 * go wrong here (SKIP LOCKED contention, lease expiry, unique-index idempotency)
 * is a property of Postgres, not of the TypeScript.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, pool } from "../lib/db";
import { jobs } from "../lib/db/schema";
import { claim, complete, enqueue, fail, heartbeat, reap } from "../lib/queue";

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

/**
 * Only ever touch rows this script created.
 *
 * `claim()` deliberately has no notion of a test scope — it takes the oldest
 * eligible job of a kind, whatever created it. So the suite asserts on the queue
 * being otherwise EMPTY of claimable work, and bails if it isn't, rather than
 * silently claiming a real job and reporting a false failure.
 */
const TAG = `test-${Date.now()}`;
const mine = () => sql`${jobs.payload}->>'tag' = ${TAG}`;

async function cleanup() {
  await db.delete(jobs).where(mine());
}

/** Assert no claimable jobs exist, so `claim()` results are unambiguous. */
async function assertQueueIdle(): Promise<void> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(inArray(jobs.status, ["queued", "running"]), sql`run_after <= now()`));
  if (n > 0) {
    throw new Error(
      `${n} claimable job(s) already in the queue. This suite calls claim() directly and ` +
        `would take them. Stop the worker and clear them first:\n` +
        `  delete from jobs where status in ('queued','running');`,
    );
  }
}

async function main() {
  await assertQueueIdle();

  // The web server now boots its own job runner (instrumentation.ts), and it is
  // a LEGITIMATE competitor for claims — stealing this suite's jobs is the
  // system working. This suite's premise is exclusive claiming, so detect a
  // live runner with a canary and skip rather than report false failures.
  const canary = await enqueue({
    kind: "mipmap",
    payload: { tag: TAG, sku: "__canary__" },
  });
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, canary.job.id) });
    if (!row || row.status !== "queued") {
      console.log(
        "\nSKIP: a live job runner is draining this queue (the web server starts\n" +
          "one), so exclusive-claim assertions cannot hold here. Run this suite on an\n" +
          "isolated database, or start the server with DISABLE_JOB_RUNNER=1.",
      );
      await cleanup();
      return;
    }
  }
  // Canary unclaimed after 5s: no competitor. Remove it and proceed.
  await db.delete(jobs).where(eq(jobs.id, canary.job.id));

  console.log("\n1. enqueue + claim + complete");
  {
    const { job, created } = await enqueue({
      kind: "mipmap",
      payload: { tag: TAG, sku: "A" },
    });
    check("enqueue creates a job", created && job.status === "queued");
    check("attempts starts at 0", job.attempts === 0);

    const claimed = await claim("w1", ["mipmap"]);
    check("claim returns it", claimed?.id === job.id);
    check("status -> running", claimed?.status === "running");
    check("attempts incremented at claim", claimed?.attempts === 1);
    check("lease is set", claimed?.leaseExpiresAt != null);
    check("locked_by recorded", claimed?.lockedBy === "w1");

    await complete(job.id);
    const done = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("complete -> done", done?.status === "done");
    check("lease cleared on completion", done?.leaseExpiresAt === null);
  }

  console.log("\n2. idempotency key prevents a double-charge");
  {
    const key = `${TAG}-idem`;
    const a = await enqueue({ kind: "render", payload: { tag: TAG }, idempotencyKey: key });
    const b = await enqueue({ kind: "render", payload: { tag: TAG }, idempotencyKey: key });
    check("first enqueue creates", a.created);
    check("second returns existing, does not create", !b.created && b.job.id === a.job.id);

    // The real double-click: two concurrent requests, not two sequential ones.
    const conc = `${TAG}-race`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueue({ kind: "render", payload: { tag: TAG }, idempotencyKey: conc }),
      ),
    );
    const createdCount = results.filter((r) => r.created).length;
    const ids = new Set(results.map((r) => r.job.id));
    check("8 concurrent enqueues create exactly 1", createdCount === 1, `created ${createdCount}`);
    check("all 8 see the same job", ids.size === 1, `${ids.size} distinct ids`);

    // Drain them: `claim` takes the oldest eligible job of that kind, so leaving
    // these queued would make later `render` tests claim these instead of the
    // job they just enqueued.
    await complete(a.job.id);
    await complete(results[0].job.id);
  }

  console.log("\n3. SKIP LOCKED: concurrent workers never get the same job");
  {
    const n = 12;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        enqueue({ kind: "mipmap", payload: { tag: TAG, i } }),
      ),
    );

    const claims = await Promise.all(
      Array.from({ length: n + 4 }, (_, i) => claim(`race-w${i}`, ["mipmap"])),
    );
    const got = claims.filter((c): c is NonNullable<typeof c> => c !== null);
    const unique = new Set(got.map((j) => j.id));

    check(`claimed all ${n} jobs`, got.length === n, `got ${got.length}`);
    check("no job claimed twice", unique.size === got.length);
    check("surplus workers got null", claims.length - got.length === 4);

    for (const j of got) await complete(j.id);
  }

  console.log("\n4. priority and run_after ordering");
  {
    await enqueue({ kind: "mipmap", payload: { tag: TAG, n: "low" }, priority: 0 });
    await enqueue({ kind: "mipmap", payload: { tag: TAG, n: "high" }, priority: 10 });
    await enqueue({ kind: "mipmap", payload: { tag: TAG, n: "delayed" }, delayMs: 60_000 });

    const first = await claim("w-order", ["mipmap"]);
    check("higher priority first", first?.payload.n === "high", String(first?.payload.n));
    const second = await claim("w-order", ["mipmap"]);
    check("then the low-priority one", second?.payload.n === "low", String(second?.payload.n));
    const third = await claim("w-order", ["mipmap"]);
    check("delayed job is NOT claimable yet", third === null, String(third?.payload.n));

    if (first) await complete(first.id);
    if (second) await complete(second.id);
  }

  console.log("\n5. kind filter");
  {
    const r = await enqueue({ kind: "render", payload: { tag: TAG, k: "r" } });
    const notMine = await claim("w-kind", ["mipmap"]);
    check("a mipmap-only worker skips a render job", notMine === null);
    const mineNow = await claim("w-kind", ["render"]);
    check("a render worker claims it", mineNow?.id === r.job.id);
    await complete(r.job.id);
  }

  console.log("\n6. retry with backoff, then dead-letter");
  {
    const { job } = await enqueue({
      kind: "mipmap",
      payload: { tag: TAG, f: 1 },
      maxAttempts: 2,
    });

    const c1 = await claim("w-fail", ["mipmap"]);
    const r1 = await fail(c1!.id, new Error("transient"));
    check("first failure retries", !r1.deadLettered && (r1.retryInMs ?? 0) > 0);

    const requeued = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("status back to queued", requeued?.status === "queued");
    check("run_after pushed into the future", (requeued?.runAfter?.getTime() ?? 0) > Date.now());
    check("error recorded", requeued?.lastError?.includes("transient") === true);
    check("not claimable during backoff", (await claim("w-fail", ["mipmap"])) === null);

    // Skip the backoff rather than sleeping for it.
    await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));

    const c2 = await claim("w-fail", ["mipmap"]);
    check("claimable after backoff elapses", c2?.id === job.id);
    check("attempts now at max", c2?.attempts === 2);

    const r2 = await fail(c2!.id, new Error("still broken"));
    check("second failure dead-letters (maxAttempts=2)", r2.deadLettered);

    const dead = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("status -> dead", dead?.status === "dead");
    check("dead_lettered_at stamped", dead?.deadLetteredAt != null);
    check("dead jobs are not claimable", (await claim("w-fail", ["mipmap"])) === null);
  }

  console.log("\n7. PermanentError path: no retry, straight to dead");
  {
    const { job } = await enqueue({ kind: "render", payload: { tag: TAG, p: 1 }, maxAttempts: 5 });
    const c = await claim("w-perm", ["render"]);
    const r = await fail(c!.id, new Error("bad payload"), { retryable: false });
    check("dead-letters on attempt 1 of 5", r.deadLettered);
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("attempts stayed at 1 (no wasted paid calls)", row?.attempts === 1);
  }

  console.log("\n8. THE CRASH CASE: expired lease is reclaimed");
  {
    const { job } = await enqueue({ kind: "mipmap", payload: { tag: TAG, c: 1 }, maxAttempts: 3 });
    const claimed = await claim("w-doomed", ["mipmap"]);
    check("claimed by the doomed worker", claimed?.id === job.id);

    // Simulate SIGKILL: the row stays `running` with a lease and nobody to renew it.
    check("reap ignores a live lease", (await reap()) === 0);

    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id));

    const reaped = await reap();
    check("reap reclaims the expired lease", reaped === 1, `reaped ${reaped}`);

    const back = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("back to queued", back?.status === "queued");
    check("locked_by cleared", back?.lockedBy === null);
    check("attempts preserved (1), so retries stay bounded", back?.attempts === 1);
    check("reason recorded", back?.lastError?.includes("lease expired") === true);

    const again = await claim("w-survivor", ["mipmap"]);
    check("another worker can now claim it", again?.id === job.id);
    check("attempts incremented again", again?.attempts === 2);
    await complete(job.id);
  }

  console.log("\n9. heartbeat extends a lease; a stale worker cannot");
  {
    const { job } = await enqueue({ kind: "mipmap", payload: { tag: TAG, h: 1 } });
    const c = await claim("w-beat", ["mipmap"]);
    const before = c!.leaseExpiresAt!.getTime();

    await new Promise((r) => setTimeout(r, 1100));
    check("owner's heartbeat succeeds", await heartbeat(job.id, "w-beat"));

    const after = (await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) }))!;
    check("lease pushed forward", after.leaseExpiresAt!.getTime() > before);
    check("a different worker cannot heartbeat it", !(await heartbeat(job.id, "w-impostor")));

    await complete(job.id);
    check("cannot heartbeat a completed job", !(await heartbeat(job.id, "w-beat")));
  }

  console.log("\n10. a job reaped past its attempt budget dies instead of looping");
  {
    const { job } = await enqueue({ kind: "mipmap", payload: { tag: TAG, k: 1 }, maxAttempts: 1 });
    await claim("w-oom", ["mipmap"]);
    await db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, job.id));

    await reap();
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) });
    check("reap dead-letters rather than re-queueing forever", row?.status === "dead");
  }

  const leftover = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(mine(), inArray(jobs.status, ["queued", "running"]), sql`run_after <= now()`));
  check("suite leaves no claimable jobs behind", leftover[0].n === 0, `${leftover[0].n} left`);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => pool.end());
