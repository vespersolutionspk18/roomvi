/**
 * Next instrumentation — runs once per server process at startup.
 *
 * This is where the job runner lives now: the web server claims and executes
 * queue jobs in-process, so there is no separate worker deployment. Guards:
 *
 *  - nodejs runtime only (edge has no pg)
 *  - never during `next build` (prerender workers must not spawn runners)
 *  - DISABLE_JOB_RUNNER=1 opts a replica out (e.g. a second web box behind
 *    one that already drains, or local dev with `npm run worker` instead)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.DISABLE_JOB_RUNNER === "1") return;

  const { ensureJobRunner } = await import("./lib/runner");
  ensureJobRunner();
}
