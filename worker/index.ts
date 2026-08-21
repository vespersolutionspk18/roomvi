/**
 * The job runner boots with the web server itself (instrumentation.ts) — this
 * CLI is only for running jobs on a SECOND box, or locally when you want the
 * web server free of job CPU. Nothing in the deployment requires it anymore.
 */
import { ensureJobRunner } from "@/lib/runner";

const state = ensureJobRunner();

const shutdown = async (signal: string) => {
  console.log(`\n${signal} — draining`);
  await state?.stop();
  console.log("worker stopped");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Keep the event loop alive; the runner's listener and timers do that too, but
// an explicit handle makes the intent obvious.
setInterval(() => {}, 1 << 30);
