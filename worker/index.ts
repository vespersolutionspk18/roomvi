/**
 * The worker process. Run alongside `next dev`:
 *
 *   terminal 1:  npm run dev
 *   terminal 2:  npm run worker
 *
 * Windows note: no `&&` chaining, and SIGKILL-equivalent (`taskkill /F`) gives
 * no chance to clean up — which is exactly the case the lease exists for. Ctrl-C
 * takes the graceful path below; a hard kill leaves the job `running` until
 * `reap()` reclaims it, and a re-run is safe because handlers are idempotent.
 *
 * Concurrency is bounded per-kind rather than globally. A render is a long wait
 * on fal (I/O bound, cheap to hold) while a Precision render is CPU bound and
 * will starve everything else if several run at once.
 */
import { hostname } from "node:os";
import { Client } from "pg";
import { pool } from "@/lib/db";
import {
  HEARTBEAT_MS,
  JOB_CHANNEL,
  REAP_EVERY_MS,
  claim,
  complete,
  fail,
  heartbeat,
  reap,
  stats,
} from "@/lib/queue";
import type { Job } from "@/lib/db/schema";
import { PermanentError } from "./errors";
import { handlers } from "./handlers";

const WORKER_ID = `${hostname()}:${process.pid}`;

/** Poll floor. NOTIFY handles the common case; this catches delayed retries. */
const POLL_MS = 2_000;

/** Max jobs in flight per kind. */
const CONCURRENCY: Record<Job["kind"], number> = {
  // fal calls: mostly waiting on the network.
  analyze: 3,
  render: 3,
  // Local image crunching; more than one saturates the CPU and slows everything.
  mipmap: 1,
};

const inFlight: Record<Job["kind"], number> = { analyze: 0, render: 0, mipmap: 0 };

let shuttingDown = false;
let wakeUp: (() => void) | null = null;

function availableKinds(): Job["kind"][] {
  return (Object.keys(CONCURRENCY) as Job["kind"][]).filter(
    (k) => inFlight[k] < CONCURRENCY[k],
  );
}

/**
 * Run one job. Never throws — a rejected promise here would take the worker
 * down and strand every other in-flight job until its lease expired.
 */
async function run(job: Job): Promise<void> {
  inFlight[job.kind]++;

  // Keep the lease alive while the handler works. A fal render can exceed the
  // 2-minute lease, and being reaped mid-flight means paying for the same
  // generation twice.
  const beat = setInterval(() => {
    heartbeat(job.id, WORKER_ID).catch((err) =>
      console.error(`[${job.kind} ${job.id}] heartbeat failed`, err),
    );
  }, HEARTBEAT_MS);

  const started = Date.now();
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`no handler for kind '${job.kind}'`);

    await handler(job, { workerId: WORKER_ID });
    await complete(job.id);
    console.log(`[${job.kind} ${job.id}] done in ${Date.now() - started}ms`);
  } catch (err) {
    const retryable = !(err instanceof PermanentError);
    try {
      const outcome = await fail(job.id, err, { retryable });
      const detail = outcome.deadLettered
        ? "dead-lettered"
        : `retry in ${Math.round((outcome.retryInMs ?? 0) / 1000)}s`;
      console.error(
        `[${job.kind} ${job.id}] attempt ${job.attempts}/${job.maxAttempts} failed (${detail}):`,
        err instanceof Error ? err.message : err,
      );
    } catch (bookkeeping) {
      // The database is unreachable. The lease will expire and another worker
      // (or this one, later) picks the job up — which is the whole point.
      console.error(`[${job.kind} ${job.id}] could not record failure`, bookkeeping);
    }
  } finally {
    clearInterval(beat);
    inFlight[job.kind]--;
    wakeUp?.();
  }
}

/**
 * LISTEN needs its own connection held open for the process lifetime; a pooled
 * client would be returned to the pool and lose the subscription.
 *
 * Reconnects on error, and `current` is reassigned so shutdown closes the LIVE
 * client rather than a dead one it captured at startup. Losing NOTIFY silently
 * degrades to poll-only latency — the kind of thing you only notice under load.
 */
const listener: { current: Client | null } = { current: null };

async function startListener(): Promise<void> {
  // NEON DIRECT, NOT THE POOLER. The `-pooler` host routes through PgBouncer in
  // transaction mode, which does not deliver NOTIFY — a LISTEN there subscribes
  // successfully and then never fires, and the worker degrades to blind polling
  // with nothing in the logs to say why. The listener is one long-lived session,
  // exactly what the direct endpoint exists for; everything else keeps using the
  // pooled URL. Falls back to DATABASE_URL for plain local Postgres.
  const client = new Client({
    connectionString: process.env.NEON_DIRECT_URL ?? process.env.DATABASE_URL,
  });

  client.on("notification", () => wakeUp?.());
  client.on("error", (err) => {
    console.error("[listen] connection error, reconnecting", err.message);
    client.end().catch(() => {});
    if (listener.current === client) listener.current = null;
    if (!shuttingDown) {
      setTimeout(() => {
        void startListener().catch((e) =>
          console.error("[listen] reconnect failed", e.message),
        );
      }, 1_000);
    }
  });

  await client.connect();
  await client.query(`listen ${JOB_CHANNEL}`);
  listener.current = client;
}

async function main() {
  console.log(`worker ${WORKER_ID} starting`);
  console.log(`  concurrency: ${JSON.stringify(CONCURRENCY)}`);
  console.log(`  queue: ${JSON.stringify(await stats())}`);

  const listenerReady = await startListener()
    .then(() => true)
    .catch((err) => {
      // Poll-only is degraded but functional; don't refuse to start.
      console.error("[listen] unavailable, falling back to polling:", err.message);
      return false;
    });
  if (listenerReady) console.log("  listening on", JOB_CHANNEL);

  const reaper = setInterval(() => {
    reap()
      .then((n) => {
        if (n > 0) {
          console.warn(`[reap] reclaimed ${n} job(s) with expired leases`);
          wakeUp?.();
        }
      })
      .catch((err) => console.error("[reap] failed", err));
  }, REAP_EVERY_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — draining ${sumInFlight()} in-flight job(s)`);
    clearInterval(reaper);
    wakeUp?.();

    // Give running handlers a chance to finish so they aren't reaped and re-run.
    const deadline = Date.now() + 30_000;
    while (sumInFlight() > 0 && Date.now() < deadline) {
      await sleep(200);
    }
    if (sumInFlight() > 0) {
      console.warn(`${sumInFlight()} job(s) still running; their leases will expire`);
    }

    await listener.current?.end().catch(() => {});
    await pool.end().catch(() => {});
    console.log("worker stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Main loop: drain everything claimable, then sleep until NOTIFY or POLL_MS.
  while (!shuttingDown) {
    let claimed = false;

    const kinds = availableKinds();
    if (kinds.length > 0) {
      try {
        const job = await claim(WORKER_ID, kinds);
        if (job) {
          claimed = true;
          // Deliberately not awaited: the loop goes straight back to claiming so
          // several jobs run concurrently up to the per-kind cap.
          void run(job);
        }
      } catch (err) {
        console.error("[claim] failed", err);
        await sleep(1_000);
      }
    }

    if (!claimed) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          wakeUp = null;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, POLL_MS);
        wakeUp = finish;
      });
    }
  }
}

const sumInFlight = () => Object.values(inFlight).reduce((a, b) => a + b, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("worker crashed", err);
  process.exit(1);
});
