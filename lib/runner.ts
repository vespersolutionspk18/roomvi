/**
 * The in-process job runner.
 *
 * The separate worker process is gone. The web server claims jobs from the same
 * Postgres queue itself, via Next's instrumentation hook — one long-lived Node
 * server runs the entire product. Everything that made the queue worth having
 * survives unchanged: idempotency keys, leases, retries, dead-lettering, and
 * crash recovery (a job whose lease expires is reclaimed by this same loop on
 * the next boot).
 *
 * `npm run worker` still exists as a thin CLI around this module for anyone who
 * wants to scale jobs onto a second box later — but nothing requires it.
 */
import { hostname } from "node:os";
import { Client } from "pg";
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
import { PermanentError } from "@/worker/errors";
import { handlers } from "@/worker/handlers";

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

type RunnerState = {
  inFlight: Record<Job["kind"], number>;
  running: boolean;
  wakeUp: (() => void) | null;
  listener: Client | null;
  stop: () => Promise<void>;
};

const globalForRunner = globalThis as unknown as { __roomviRunner?: RunnerState };

const sumInFlight = (s: RunnerState) =>
  Object.values(s.inFlight).reduce((a, b) => a + b, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(state: RunnerState, job: Job): Promise<void> {
  state.inFlight[job.kind]++;

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
        err instanceof Error ? `${err.message}${err.cause ? ` — cause: ${String(err.cause)}` : ""}` : err,
      );
    } catch (bookkeeping) {
      console.error(`[${job.kind} ${job.id}] could not record failure`, bookkeeping);
    }
  } finally {
    clearInterval(beat);
    state.inFlight[job.kind]--;
    state.wakeUp?.();
  }
}

/**
 * LISTEN needs its own connection held open for the process lifetime; a pooled
 * client would be returned to the pool and lose the subscription. NEON DIRECT,
 * NOT THE POOLER: PgBouncer's transaction mode accepts LISTEN and then never
 * delivers a notification.
 */
async function startListener(state: RunnerState): Promise<void> {
  const client = new Client({
    connectionString: process.env.NEON_DIRECT_URL ?? process.env.DATABASE_URL,
  });

  client.on("notification", () => state.wakeUp?.());
  client.on("error", (err) => {
    console.error("[listen] connection error, reconnecting", err.message);
    client.end().catch(() => {});
    if (state.listener === client) state.listener = null;
    if (state.running) {
      setTimeout(() => {
        void startListener(state).catch((e) =>
          console.error("[listen] reconnect failed", e.message),
        );
      }, 1_000);
    }
  });

  await client.connect();
  await client.query(`listen ${JOB_CHANNEL}`);
  state.listener = client;
}

/**
 * Start the runner exactly once per server process. Safe to call repeatedly
 * (Next dev re-evaluates modules; instrumentation can register more than once).
 */
export function ensureJobRunner(): RunnerState | null {
  if (!process.env.DATABASE_URL) return null;

  if (globalForRunner.__roomviRunner) return globalForRunner.__roomviRunner;

  const state: RunnerState = {
    inFlight: { analyze: 0, render: 0, mipmap: 0 },
    running: true,
    wakeUp: null,
    listener: null,
    stop: async () => {
      state.running = false;
      state.wakeUp?.();
      const deadline = Date.now() + 30_000;
      while (sumInFlight(state) > 0 && Date.now() < deadline) {
        await sleep(200);
      }
      await state.listener?.end().catch(() => {});
      // The pool belongs to the web server too — it stays open.
    },
  };
  globalForRunner.__roomviRunner = state;

  console.log(`job runner ${WORKER_ID} starting (in-process)`);
  console.log(`  concurrency: ${JSON.stringify(CONCURRENCY)}`);
  void stats()
    .then((s) => console.log(`  queue: ${JSON.stringify(s)}`))
    .catch(() => {});

  void startListener(state)
    .then(() => console.log("  listening on", JOB_CHANNEL))
    .catch((err) => {
      // Poll-only is degraded but functional; don't refuse to start.
      console.error("[listen] unavailable, falling back to polling:", err.message);
    });

  setInterval(() => {
    reap()
      .then((n) => {
        if (n > 0) {
          console.warn(`[reap] reclaimed ${n} job(s) with expired leases`);
          state.wakeUp?.();
        }
      })
      .catch((err) => console.error("[reap] failed", err));
  }, REAP_EVERY_MS);

  // The loop. Drains everything claimable, then sleeps until NOTIFY or POLL_MS.
  void (async () => {
    while (state.running) {
      let claimed = false;

      const kinds = (Object.keys(CONCURRENCY) as Job["kind"][]).filter(
        (k) => state.inFlight[k] < CONCURRENCY[k],
      );
      if (kinds.length > 0) {
        try {
          const job = await claim(WORKER_ID, kinds);
          if (job) {
            claimed = true;
            // Not awaited: the loop goes straight back to claiming so several
            // jobs run concurrently up to the per-kind cap.
            void runJob(state, job);
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
            state.wakeUp = null;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, POLL_MS);
          state.wakeUp = finish;
        });
      }
    }
  })().catch((err) => console.error("job runner crashed", err));

  return state;
}
