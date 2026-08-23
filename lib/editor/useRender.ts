"use client";

/**
 * Submit a render and follow it to completion.
 *
 * Polled, not streamed. The reasoning is in `app/api/renders/[id]/route.ts`: a
 * render emits about four state changes over 20-90s, and an EventSource held open
 * through a dev hot-reload drops silently, leaving the UI waiting on an event that
 * will never arrive.
 *
 * THIS HOOK SPENDS MONEY. Every submit that is not deduplicated server-side is a
 * real charge against the user's fal credits, which is why:
 *
 *  - `submit` refuses to start while one is already in flight. Server-side
 *    idempotency already collapses a double-click into one job, but relying on
 *    that for something the UI can prevent outright would be sloppy.
 *  - The poll STOPS on a terminal status, and on the ceiling. A poll loop that
 *    outlives its render is how a tab quietly generates thousands of requests.
 *  - A failure is surfaced verbatim, including the queue's own error. "Nothing
 *    happened" after a charge is the worst outcome available.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Executor, RenderOpInput, RenderState } from "./types";

/**
 * How long to follow a render before calling it lost.
 *
 * Generous: nano-banana at "high" thinking on a 2K image can take 90s, and a
 * queued job behind another render waits on top of that. The ceiling exists to
 * turn "the worker is not running" into a message instead of an eternal spinner,
 * not to cut off slow-but-working renders.
 */
const DEADLINE_MS = 6 * 60_000;

/** Tight enough to feel responsive, loose enough not to hammer the route. */
const POLL_MS = 1500;

export type RenderPhase = "idle" | "submitting" | "running" | "done" | "failed";

export function useRender(imageId: string) {
  const [phase, setPhase] = useState<RenderPhase>("idle");
  const [render, setRender] = useState<RenderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True when the server recognised the request as a repeat and charged nothing. */
  const [reused, setReused] = useState(false);

  const alive = useRef(true);
  // Read inside the async poll loop, which closes over the phase at submit time and
  // would otherwise keep polling a render the user has already moved on from.
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    activeId.current = null;
    setPhase("idle");
    setRender(null);
    setError(null);
    setReused(false);
  }, []);

  /**
   * Follow one render id to a terminal state.
   *
   * Split out from `submit` so a page reload can rejoin a render already in
   * flight — the id is all it takes, and abandoning a paid render because the
   * browser refreshed would be inexcusable.
   */
  const follow = useCallback(async (renderId: string) => {
    activeId.current = renderId;
    const deadline = Date.now() + DEADLINE_MS;

    for (;;) {
      if (!alive.current || activeId.current !== renderId) return;

      const res = await fetch(`/api/renders/${renderId}`);
      if (!res.ok) throw new Error(`Could not read render ${renderId}.`);
      const state: RenderState = await res.json();

      if (!alive.current || activeId.current !== renderId) return;
      setRender(state);

      // THE ROW FIRST, THE QUEUE SECOND. A ready row wins over a dead job, because
      // a render whose work succeeded and whose bookkeeping failed can be recovered
      // from the output on disk while its job stays dead-lettered forever. The route
      // withholds `queueStatus` on a ready row too — this order is the second half
      // of that, so neither side alone can show the user a failure for a render they
      // are looking at.
      if (state.status === "ready") {
        setPhase("done");
        return;
      }
      if (state.status === "failed" || state.status === "cancelled") {
        // The row's own message first, then the queue's. A handler that died
        // before it could write the row leaves only the latter.
        setError(state.error ?? state.queueError ?? "The render failed.");
        setPhase("failed");
        return;
      }
      if (state.queueStatus === "dead") {
        setError(state.queueError ?? "The render job was dead-lettered.");
        setPhase("failed");
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          state.status === "queued"
            ? "The render is still queued. Is the worker running? (npm run worker)"
            : "The render timed out.",
        );
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }, []);

  const submit = useCallback(
    async (
      ops: RenderOpInput[],
      opts: {
        seed?: number | null;
        executor?: Executor;
        baseRenderId?: string | null;
        /** Ask the server to outpaint this render to the given aspect ratio. */
        expand?: { ratioW: number; ratioH: number };
      } = {},
    ) => {
      // Not merely a nicety: without it a double-click sends two requests, and
      // while the server collapses them, the second still races the first's poll.
      if (phase === "submitting" || phase === "running") return null;

      setPhase("submitting");
      setError(null);
      setReused(false);
      setRender(null);

      try {
        const res = await fetch("/api/renders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageId,
            ops,
            seed: opts.seed ?? null,
            // Omitted rather than defaulted to "generative", so the server owns the
            // default in one place. Sending it explicitly from here would make this
            // hook a second source of truth about which path costs money.
            ...(opts.executor ? { executor: opts.executor } : {}),
            // Present only when building on a selected version; omitted means
            // the original photo, which is the server's default too.
            ...(opts.baseRenderId ? { baseRenderId: opts.baseRenderId } : {}),
            ...(opts.expand ? { expand: opts.expand } : {}),
          }),
        });
        const body = await res.json();

        if (!res.ok) {
          throw new Error(body?.error?.message ?? "The render could not be submitted.");
        }
        if (!alive.current) return null;

        setReused(Boolean(body.reused));
        setPhase("running");
        await follow(body.renderId);
        return body.renderId as string;
      } catch (err) {
        if (!alive.current) return null;
        setError(err instanceof Error ? err.message : "The render could not be submitted.");
        setPhase("failed");
        return null;
      }
    },
    [imageId, phase, follow],
  );

  /** Rejoin a render already in flight, e.g. after a reload. */
  const resume = useCallback(
    async (renderId: string) => {
      setPhase("running");
      setError(null);
      try {
        await follow(renderId);
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : "Lost track of that render.");
        setPhase("failed");
      }
    },
    [follow],
  );

  return {
    phase,
    render,
    error,
    reused,
    busy: phase === "submitting" || phase === "running",
    submit,
    resume,
    reset,
  };
}
