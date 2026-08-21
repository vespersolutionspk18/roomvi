/**
 * Postgres-as-queue.
 *
 * Why Postgres and not Redis/BullMQ: the jobs are already transactionally tied
 * to rows (a render job must not exist unless its `renders` row and its credit
 * debit exist). One database means enqueue-with-the-write is a single COMMIT,
 * so there is no window where we have charged a user for a job that was never
 * queued, or queued a job whose render row rolled back.
 *
 * The three mechanisms that make it safe:
 *
 *  1. `FOR UPDATE SKIP LOCKED` — N workers claim disjoint jobs with no
 *     coordination and no lost wakeups.
 *  2. A LEASE, not a lock. A worker that is SIGKILLed holds no lock to release,
 *     so a claim alone would strand the job as `running` forever. `reap()`
 *     returns any job whose lease elapsed. This is why the worker must
 *     `heartbeat()` during long fal polls — a 4-minute render would otherwise
 *     be reaped and re-submitted mid-flight, paying twice.
 *  3. Idempotency key — a unique index. A double-clicked Render button inserts
 *     once; the second insert conflicts and returns the existing job.
 *
 * Retries are capped and dead-lettered rather than infinite: a job that fails
 * three times is failing deterministically, and retrying it forever on a paid
 * API is how a bug becomes an invoice.
 */
import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, pool } from "./db";
import { jobs, type Job } from "./db/schema";

/** How long a claim is valid before `reap()` may take it back. */
export const LEASE_MS = 2 * 60 * 1000;

/**
 * How often the worker sweeps for expired leases.
 *
 * Lives here rather than in the worker so tests can wait exactly one sweep
 * instead of guessing. Must stay well under LEASE_MS or a crashed worker's job
 * sits idle for most of a lease before anyone notices.
 */
export const REAP_EVERY_MS = 30 * 1000;

/** Lease renewal cadence. Well under LEASE_MS so one dropped beat is survivable. */
export const HEARTBEAT_MS = 45 * 1000;

/** Postgres NOTIFY channel. Payload is the job kind, for logging only. */
export const JOB_CHANNEL = "roomvi_jobs";

export type EnqueueOptions = {
  kind: Job["kind"];
  payload: Record<string, unknown>;
  /** Higher runs first. */
  priority?: number;
  maxAttempts?: number;
  /** Delay before the job becomes claimable. */
  delayMs?: number;
  /**
   * Dedupe key. Two enqueues with the same key produce ONE job, ever — the
   * table has a unique index, so this survives concurrent requests, not just
   * sequential ones.
   */
  idempotencyKey?: string;
};

/**
 * Insert a job and wake a worker.
 *
 * Pass `tx` to enqueue inside a transaction that also writes the row the job
 * operates on. The NOTIFY is deliberately issued in the same statement batch:
 * Postgres defers notification delivery until COMMIT, so a rolled-back
 * transaction never wakes a worker for a job that does not exist.
 */
export async function enqueue(
  opts: EnqueueOptions,
  tx: Pick<typeof db, "insert" | "execute"> = db,
): Promise<{ job: Job; created: boolean }> {
  const values = {
    kind: opts.kind,
    payload: opts.payload,
    priority: opts.priority ?? 0,
    maxAttempts: opts.maxAttempts ?? 3,
    runAfter: opts.delayMs
      ? sql`now() + ${`${Math.ceil(opts.delayMs / 1000)} seconds`}::interval`
      : sql`now()`,
    idempotencyKey: opts.idempotencyKey ?? null,
  };

  const inserted = await tx
    .insert(jobs)
    .values(values)
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();

  if (inserted.length === 0) {
    // Idempotency key already present — return the job that owns it.
    const existing = await db.query.jobs.findFirst({
      where: eq(jobs.idempotencyKey, opts.idempotencyKey!),
    });
    if (!existing) {
      throw new Error(`enqueue: conflict on ${opts.idempotencyKey} but no row found`);
    }
    return { job: existing, created: false };
  }

  await tx.execute(sql`select pg_notify(${JOB_CHANNEL}, ${opts.kind})`);
  return { job: inserted[0], created: true };
}

/**
 * Claim the next eligible job for `workerId`, or null.
 *
 * The subquery + `FOR UPDATE SKIP LOCKED` is the whole trick: the SELECT locks
 * exactly one candidate row and skips rows other workers hold, then the outer
 * UPDATE stamps the lease. Both happen in one statement, so there is no window
 * between choosing and claiming.
 *
 * Ordering is `priority DESC, run_after ASC` — oldest-eligible within a
 * priority band, so a backlog drains FIFO rather than starving old jobs.
 */
export async function claim(workerId: string, kinds?: Job["kind"][]): Promise<Job | null> {
  // Kinds are passed as a bound array parameter, never interpolated. `$3 is null`
  // makes one statement serve both the filtered and unfiltered case, so the
  // planner sees a single prepared shape.
  const { rows } = await pool.query<JobRow>(
    `
    update jobs
       set status           = 'running',
           attempts         = jobs.attempts + 1,
           locked_at        = now(),
           locked_by        = $1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           updated_at       = now()
     where jobs.id = (
       select id from jobs
        where status = 'queued'
          and run_after <= now()
          and ($3::text[] is null or kind::text = any($3::text[]))
        order by priority desc, run_after asc
        limit 1
          for update skip locked
     )
    returning *
    `,
    [workerId, String(LEASE_MS), kinds?.length ? kinds : null],
  );

  return rows[0] ? toJob(rows[0]) : null;
}

/**
 * Raw driver rows are snake_case; Drizzle's `Job` is camelCase. This runs on the
 * one query that has to bypass the query builder (`FOR UPDATE SKIP LOCKED` in a
 * subquery of an UPDATE), so the mapping is explicit rather than trusting a cast.
 */
type JobRow = {
  id: string;
  kind: Job["kind"];
  payload: Record<string, unknown>;
  status: Job["status"];
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_at: Date | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  idempotency_key: string | null;
  last_error: string | null;
  dead_lettered_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    leaseExpiresAt: r.lease_expires_at,
    idempotencyKey: r.idempotency_key,
    lastError: r.last_error,
    deadLetteredAt: r.dead_lettered_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Extend the lease on a job this worker holds. Call during long external waits. */
export async function heartbeat(jobId: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `
    update jobs
       set lease_expires_at = now() + ($3 || ' milliseconds')::interval,
           updated_at       = now()
     where id = $1 and locked_by = $2 and status = 'running'
    `,
    [jobId, workerId, String(LEASE_MS)],
  );
  return (rowCount ?? 0) > 0;
}

export async function complete(jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "done",
      lockedBy: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Record a failure and either schedule a retry or dead-letter.
 *
 * Backoff is exponential with jitter. The jitter is not decoration: without it,
 * a batch of jobs that failed together (fal outage) retries in lockstep and
 * hammers the recovering service at exactly the same instants.
 */
export async function fail(
  jobId: string,
  error: unknown,
  opts: { retryable?: boolean } = {},
): Promise<{ deadLettered: boolean; retryInMs: number | null }> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const job = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!job) throw new Error(`fail: job ${jobId} not found`);

  const retryable = opts.retryable ?? true;
  const exhausted = job.attempts >= job.maxAttempts;

  if (!retryable || exhausted) {
    await db
      .update(jobs)
      .set({
        status: "dead",
        lastError: message.slice(0, 4000),
        deadLetteredAt: new Date(),
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));
    return { deadLettered: true, retryInMs: null };
  }

  // 2^attempts seconds, capped at 5 min, plus up to 25% jitter.
  const base = Math.min(2 ** job.attempts * 1000, 5 * 60 * 1000);
  const retryInMs = Math.round(base * (1 + Math.random() * 0.25));

  await db
    .update(jobs)
    .set({
      status: "queued",
      lastError: message.slice(0, 4000),
      runAfter: sql`now() + ${`${Math.ceil(retryInMs / 1000)} seconds`}::interval`,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));

  return { deadLettered: false, retryInMs };
}

/**
 * Re-queue jobs whose lease expired — i.e. whose worker died mid-job.
 *
 * `attempts` was already incremented at claim time, so a job that reliably
 * kills its worker still exhausts its budget and dead-letters instead of
 * looping forever. That is the desired behaviour: an OOM on a 12MP image is
 * deterministic, and retrying it indefinitely would pin a worker permanently.
 */
export async function reap(): Promise<number> {
  const revived = await db
    .update(jobs)
    .set({
      status: sql`case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end`,
      deadLetteredAt: sql`case when attempts >= max_attempts then now() else null end`,
      lastError: sql`coalesce(last_error, 'lease expired — worker died or hung')`,
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(jobs.status, "running"),
        isNotNull(jobs.leaseExpiresAt),
        lt(jobs.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ id: jobs.id });

  return revived.length;
}

/** Queue depth by status, for the worker log and an eventual admin view. */
export async function stats(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** Jobs that need a human: dead-lettered, most recent first. */
export async function deadLetters(limit = 50) {
  return db
    .select()
    .from(jobs)
    .where(or(eq(jobs.status, "dead"), eq(jobs.status, "failed")))
    .orderBy(sql`${jobs.deadLetteredAt} desc nulls last`)
    .limit(limit);
}
