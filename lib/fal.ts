/**
 * The single door to fal.ai. Nothing else in the app talks to it.
 *
 * Three rules encoded here, each of which costs real money to get wrong:
 *
 *  1. SUBMIT AND POLL, never `fal.subscribe`. `subscribe` holds an open await for
 *     the life of the request; a Next hot-reload or a worker restart kills that
 *     await while the job keeps running on fal's side. You are billed, and the
 *     result is unreachable because nothing recorded the request id. Here the id
 *     is returned to the caller BEFORE any waiting happens, so a crash mid-poll
 *     is recoverable — the job is re-claimed and resumes polling the same id.
 *     (`subscribe` also can't use webhooks on localhost, so there is no upside.)
 *
 *  2. NEVER let a fal URL become the source of truth. Outputs expire in ~7 days.
 *     `download()` exists so every caller copies bytes to local storage in the
 *     same breath as reading the result.
 *
 *  3. The key stays server-side. A browser guard below fails loudly if this ever
 *     ends up in a client bundle. (Not `import "server-only"` — that only
 *     resolves inside Next's bundler, and this module is also imported by the
 *     worker and by scripts, which run under plain tsx.) There is deliberately
 *     no server-proxy route either: `@fal-ai/server-proxy` is an unmetered
 *     passthrough, so anyone who finds the route spends the account's credits.
 */
import { fal } from "@fal-ai/client";

if (typeof window !== "undefined") {
  throw new Error("lib/fal.ts is server-only — importing it in a client bundle leaks FAL_KEY.");
}

if (!process.env.FAL_KEY) {
  // Fail at import rather than at the first paid call, where the error would
  // arrive as an opaque 401 inside a worker job that then retries twice.
  throw new Error("FAL_KEY is not set. Add it to .env.local (never NEXT_PUBLIC_).");
}

fal.config({ credentials: process.env.FAL_KEY });

/** Terminal states, per fal's queue API. */
type FalStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";

export type SubmitResult = { requestId: string };

/**
 * Enqueue a job on fal and return its id immediately.
 *
 * Persist the returned `requestId` before awaiting anything. That is what makes
 * the work recoverable rather than merely retryable — a retry pays twice.
 */
export async function submit(
  endpointId: string,
  input: Record<string, unknown>,
): Promise<SubmitResult> {
  const queued = await fal.queue.submit(endpointId, { input });
  return { requestId: queued.request_id };
}

export type PollOptions = {
  /** Give up after this long. A stuck fal job should not pin a worker forever. */
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: FalStatus, queuePosition?: number) => void;
};

/**
 * Poll an already-submitted request to completion and return its output.
 *
 * Safe to call again for the same `requestId` after a worker restart: fal keeps
 * the result addressable, so recovery is a re-poll, not a re-submit.
 */
export async function poll<T>(
  endpointId: string,
  requestId: string,
  opts: PollOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    opts.signal?.throwIfAborted();

    const status = await fal.queue.status(endpointId, { requestId, logs: false });
    opts.onStatus?.(
      status.status as FalStatus,
      "queue_position" in status ? status.queue_position : undefined,
    );

    if (status.status === "COMPLETED") {
      const result = await fal.queue.result(endpointId, { requestId });
      return result.data as T;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `fal ${endpointId} request ${requestId} still ${status.status} after ${Math.round(
          timeoutMs / 1000,
        )}s`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Submit and poll in one call. Only for scripts — jobs must persist the id first. */
export async function run<T>(
  endpointId: string,
  input: Record<string, unknown>,
  opts: PollOptions = {},
): Promise<{ requestId: string; data: T }> {
  const { requestId } = await submit(endpointId, input);
  const data = await poll<T>(endpointId, requestId, opts);
  return { requestId, data };
}

/**
 * Fetch a fal-hosted output into memory so it can be written to storage.
 *
 * Every fal URL is a ticking clock; this is the step that stops it mattering.
 */
export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fal download failed: ${res.status} ${res.statusText} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload bytes to fal's CDN and return a URL its models can read.
 *
 * Needed because our own storage is not publicly reachable (deliberately — see
 * app/api/files). Uploads are transient inputs, never outputs we depend on.
 */
export async function upload(data: Buffer, fileName: string, contentType: string): Promise<string> {
  const file = new File([new Uint8Array(data)], fileName, { type: contentType });
  return fal.storage.upload(file);
}

/**
 * fal bills image work as `ceil(width * height / 1048576)` megapixel units.
 *
 * The consequence that actually changes decisions: 512x512 and 1024x1024 cost
 * the SAME single unit, so rendering below 1MP buys nothing, while 1025x1024
 * silently doubles the bill.
 */
export function billableUnits(width: number, height: number): number {
  return Math.max(1, Math.ceil((width * height) / 1_048_576));
}
