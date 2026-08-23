"use client";

/**
 * The editor: photo -> labels (detected once) -> aim + references + paint +
 * one sentence -> render. The AI does the changing; the version rail keeps
 * every attempt addressable against the original photo.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatBar } from "./ChatBar";
import { HistoryPanel } from "./HistoryPanel";
import { ReferencePanel, type Reference } from "./ReferencePanel";
import { Stage } from "./Stage";
import { rasterizePaintMask } from "@/lib/editor/paint";
import type {
  AnalyzeStatus,
  PaintStroke,
  RenderSummary,
  SurfacesResponse,
} from "@/lib/editor/types";
import { useRender } from "@/lib/editor/useRender";

type Phase = "idle" | "analyzing" | "ready" | "failed";

export function Editor({ imageId }: { imageId: string }) {
  const [surfaces, setSurfaces] = useState<SurfacesResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [references, setReferences] = useState<Reference[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Stage chrome.
  const [paintMode, setPaintMode] = useState(false);
  const [strokes, setStrokes] = useState<PaintStroke[]>([]);
  /** True when the user dismissed the render to look at (or paint on) the photo. */
  const [photoView, setPhotoView] = useState(false);
  /** The stage frame's live aspect ratio — what "Expand" fills toward. */
  const [frameRatio, setFrameRatio] = useState<number | null>(null);

  // Version history. `activeId` is the current truth: the version on stage,
  // badged in the rail, and the canvas the next prompt edits. A finished render
  // becomes active the instant it lands — see handlePrompt.
  const [historyOpen, setHistoryOpen] = useState(true);
  const [history, setHistory] = useState<RenderSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  const render = useRender(imageId);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Toasts auto-dismiss; the ref stops an earlier one closing a later one. */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((message: string, ms = 6000) => {
    if (!alive.current) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => alive.current && setToast(null), ms);
  }, []);

  /* ---------------------------------------------------------------- zones */

  // Detection runs once per photo in the worker; this only reads its labels.
  const loadZones = useCallback(async () => {
    const res = await fetch(`/api/images/${imageId}/surfaces`);
    if (!res.ok) throw new Error("Could not load labels");
    const data: SurfacesResponse = await res.json();
    if (!alive.current) return;
    setSurfaces(data);
  }, [imageId]);

  /* -------------------------------------------------------------- history */

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/renders?imageId=${imageId}`);
      const data = await res.json();
      if (!alive.current) return;
      setHistory(data.renders ?? []);
      // First ready render becomes active by default, so a revisit shows where
      // the room last stood rather than stripping it back to bare walls.
      setActiveId((prev) => prev ?? (data.renders as RenderSummary[]).find((r) => r.status === "ready")?.id ?? null);
    } catch {
      if (alive.current) setHistory([]);
    } finally {
      if (alive.current) setHistoryLoading(false);
    }
  }, [imageId]);

  // Initial history load. Deferred to a microtask so the effect body itself
  // stays free of synchronous state writes.
  useEffect(() => {
    queueMicrotask(() => void fetchHistory());
  }, [fetchHistory]);

  const makeActive = useCallback((id: string) => {
    setActiveId(id);
    // Choosing a version is an explicit step out of the photo view.
    setPhotoView(false);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/renders/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          say(data?.error?.message ?? "The version could not be deleted.");
          return;
        }
        // A deleted version cannot remain the one on stage.
        setActiveId((prev) => (prev === id ? null : prev));
        void fetchHistory();
      } catch {
        say("The version could not be deleted.");
      }
    },
    [fetchHistory, say],
  );

  /* --------------------------------------------------------------- analyze */

  const runAnalyze = useCallback(
    async (force = false) => {
      setPhase("analyzing");
      setError(null);
      setProgress(force ? "Re-reading the room…" : "Reading the room…");

      try {
        const res = await fetch(`/api/images/${imageId}/analyze${force ? "?force=1" : ""}`, {
          method: "POST",
        });
        const body = await res.json();

        if (body.status === "ready" && !force) {
          await loadZones();
          if (alive.current) setPhase("ready");
          return;
        }

        const deadline = Date.now() + 5 * 60_000;
        let wait = 1000;
        for (;;) {
          if (!alive.current) return;
          if (Date.now() > deadline) {
            throw new Error("Reading timed out. Is the worker running? (npm run worker)");
          }
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(wait * 1.4, 5000);

          const poll = await fetch(`/api/images/${imageId}/analyze`);
          const status: AnalyzeStatus = await poll.json();

          if (status.status === "ready") {
            await loadZones();
            if (alive.current) {
              setPhase("ready");
              setProgress("");
            }
            return;
          }
          if (status.status === "failed") {
            throw new Error(status.error ?? "Reading the room failed.");
          }
          if (alive.current) {
            setProgress(
              status.status === "running"
                ? "Finding the surfaces — about a minute…"
                : "Queued — waiting for a worker…",
            );
          }
        }
      } catch (err) {
        if (!alive.current) return;
        setPhase("failed");
        setError(err instanceof Error ? err.message : "Reading the room failed.");
      }
    },
    [imageId, loadZones],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/images/${imageId}/analyze`);
        const status: AnalyzeStatus = await res.json();
        if (cancelled) return;

        if (status.status === "ready") {
          await loadZones();
          if (!cancelled && alive.current) setPhase("ready");
        } else {
          await runAnalyze(false);
        }
      } catch (err) {
        if (!cancelled && alive.current) {
          setPhase("failed");
          setError(err instanceof Error ? err.message : "Could not reach the server.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageId, loadZones, runAnalyze]);

  /* ----------------------------------------------------------- references */

  const toggleReference = useCallback((ref: Reference) => {
    setReferences((prev) =>
      prev.some((r) => r.key === ref.key)
        ? prev.filter((r) => r.key !== ref.key)
        : prev.length >= 3
          ? prev
          : [...prev, ref],
    );
  }, []);

  const uploadReference = useCallback(
    async (file: File) => {
      setUploadingRef(true);
      try {
        // The surfaces response carries the owning project id, which is what
        // scopes the reference to this caller.
        const surfacesRes = await fetch(`/api/images/${imageId}/surfaces`);
        const surfacesData = await surfacesRes.json().catch(() => null);
        const projectId: string | undefined = surfacesData?.projectId;
        if (!projectId) throw new Error("no project");

        const form = new FormData();
        form.append("file", file);
        form.append("projectId", projectId);
        const res = await fetch("/api/references", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) {
          say(data?.error?.message ?? "The reference could not be uploaded.");
          return;
        }
        setReferences((prev) =>
          prev.length >= 3
            ? prev
            : [
                ...prev,
                { key: data.reference.key, url: data.reference.url, source: "upload", name: file.name },
              ],
        );
      } catch {
        say("The reference could not be uploaded.");
      } finally {
        if (alive.current) setUploadingRef(false);
      }
    },
    [imageId, say],
  );

  /* --------------------------------------------------------------- render */

  /** Expand: outpaint the active version to match the user's viewport ratio.
      The ratio is the stage frame's own — expansion exists so the photo can
      fill what the user actually sees. */
  const handleExpand = useCallback(() => {
    if (!surfaces || render.busy || !frameRatio) return;
    render.submit(
      [{ kind: "prompt", prompt: "Expand the scene outward to fill the frame." }],
      { baseRenderId: activeId ?? null, expand: { ratioW: frameRatio, ratioH: 1 } },
    );
  }, [surfaces, frameRatio, activeId, render]);
  const handlePrompt = useCallback(
    async (prompt: string) => {
      let maskKey: string | undefined;

      // A painted region ships as a PNG at display dimensions. Uploaded BEFORE
      // the render is submitted so a bad mask fails free of charge.
      if (strokes.length > 0 && surfaces?.width && surfaces?.height) {
        try {
          const blob = await rasterizePaintMask(strokes, surfaces.width, surfaces.height);
          const form = new FormData();
          form.append("file", blob, "mask.png");
          form.append("imageId", imageId);
          const res = await fetch("/api/paint", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok) {
            say(data?.error?.message ?? "The painted area could not be saved.");
            return;
          }
          maskKey = data.key;
        } catch {
          say("The painted area could not be prepared.");
          return;
        }
      }

      // The strokes are now encoded in the mask on disk; keeping them on screen
      // would invite painting the NEXT sentence onto the SAME region by accident.
      setStrokes([]);

      // submit resolves with the render id on success, null on failure — so
      // success handling lives HERE rather than in an effect observing a phase
      // transition afterwards.
      const id = await render.submit(
        [
          {
            kind: "prompt",
            prompt,
            ...(references.length ? { referenceKeys: references.map((r) => r.key) } : {}),
            ...(maskKey ? { maskKey } : {}),
          },
        ],
        // The ACTIVE version is the canvas: conversational editing. No active
        // selection means the original photo, which is the right default for
        // a fresh sentence about the room.
        { baseRenderId: activeId ?? null },
      );
      if (!id || !alive.current) return;

      // The fresh render IS the new truth, effective immediately: active in
      // the rail, on the stage, and the canvas for whatever is typed next.
      // Stepping back to a previous version is one click in the rail � which
      // is the whole undo affordance a history of complete versions needs.
      setActiveId(id);
      setPhotoView(false);
      void fetchHistory();

      try {
        const res = await fetch(`/api/renders/${id}`);
        const state = await res.json();
        if (!alive.current) return;
        if (state?.driftWarning) say(state.driftWarning, 14000);
      } catch {
        // The poll route will be read again by the panel; a missed toast is not
        // worth a retry loop.
      }
    },
    [strokes, surfaces, imageId, references, activeId, render, say, fetchHistory],
  );

  useEffect(() => {
    if (render.phase === "failed" && render.error) {
      say(render.error, 9000);
    }
  }, [render.phase, render.error, say]);

  /** What the stage shows: the active version — unless the user stepped back
      to the photo, which always wins. While the rail's list is still catching
      up to a just-finished render, the hook's own state covers the gap so the
      stage never flickers to photo and back. */
  const stageRenderUrl = photoView
    ? null
    : render.phase === "done" && render.render?.id === activeId
      ? (render.render?.url ?? null)
      : ((history.find((r) => r.id === activeId)?.url ?? null));

  /** What the stage says while it waits. */
  const busyNote =
    render.phase === "submitting"
      ? "Sending…"
      : render.phase === "running"
        ? render.render?.status === "running"
          ? "Making the change — usually 15-40 seconds…"
          : "Queued — waiting for a worker…"
        : null;

  /* ----------------------------------------------------------------- view */

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <ReferencePanel
        references={references}
        onToggleReference={toggleReference}
        onUploadReference={uploadReference}
        uploading={uploadingRef}
        disabled={render.busy}
      />

      <main className="flex min-w-0 flex-1 flex-col gap-3 bg-porcelain px-[18px] pb-4 pt-3.5">
        <header className="flex h-[50px] flex-shrink-0 items-center justify-between rounded-card border border-hairline bg-panel pl-3.5 pr-2 shadow-card">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="flex h-9 items-center gap-[7px] rounded-lg px-2.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-pine-tint hover:text-pine"
            >
              <span className="text-[15px] font-normal leading-none text-ink-faint">×</span> Exit
            </Link>
            <div className="h-[22px] w-px bg-hairline" />
            <span className="text-[12.5px] text-ink-soft">
              {phase === "ready" ? (
                <>
                  Click a label to aim, or paint an area, then say the change.
                </>
              ) : (
                progress || "Editor"
              )}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Labels off is a legitimate way to look at a room. */}
            <HeaderToggle
              active={paintMode}
              onClick={() => {
                // Toggling paint touches NOTHING else. While paint is on, the
                // stage suppresses the compare layer itself (the brush needs
                // the pointers); turn it off and whatever was active comes
                // straight back. The active version is never cleared.
                setPaintMode((v) => !v);
              }}
              title="Paint an area to change"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[16px] w-[16px]" aria-hidden="true">
                <path d="M15.2 5.6l3.2 3.2-8.1 8.1-4 .8.8-4 8.1-8.1Z" />
                <path d="M14 6.8l3.2 3.2" />
              </svg>
              <span>Paint</span>
            </HeaderToggle>
            <HeaderButton onClick={() => handleExpand()} disabled={!frameRatio || render.busy}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[16px] w-[16px]" aria-hidden="true">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
              Expand
            </HeaderButton>

            <div className="mx-1 h-5 w-px bg-hairline" />

            <HeaderButton onClick={() => runAnalyze(true)} disabled={phase === "analyzing"}>
              Re-read room
            </HeaderButton>
            <HeaderButton
              onClick={() => {
                const url = stageRenderUrl ?? surfaces?.imageUrl;
                if (url) window.open(url, "_blank");
              }}
              disabled={!stageRenderUrl && !surfaces?.imageUrl}
            >
              Download
            </HeaderButton>
          </div>
        </header>

        {phase === "analyzing" && (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-hairline bg-panel shadow-card">
            <div className="flex flex-col items-center gap-3">
              <svg viewBox="0 0 24 24" className="h-7 w-7 animate-spin text-pine" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
                <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
              <div className="font-display text-[19px] font-[560] text-ink">{progress}</div>
              <div className="max-w-sm text-center text-[12.5px] leading-relaxed text-ink-soft">
                One pass per photo. After this, every change is just a sentence.
              </div>
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-hairline bg-panel shadow-card">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <div className="font-display text-[19px] font-[560] text-ink">Could not read the room</div>
              <div className="text-[12.5px] text-ink-soft">{error}</div>
              <button
                onClick={() => runAnalyze(true)}
                className="mt-1 flex h-9 items-center rounded-[9px] bg-pine px-4 text-[12.5px] font-semibold text-white hover:bg-pine-dark"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {phase === "ready" && (
          <>
            <Stage
              imageUrl={surfaces?.imageUrl ?? null}
              width={surfaces?.width ?? 1}
              height={surfaces?.height ?? 1}
              renderUrl={stageRenderUrl}
              busyNote={busyNote}
              onBackToPhoto={stageRenderUrl ? () => setPhotoView(true) : undefined}
              paintMode={paintMode}
              onFrameRatio={setFrameRatio}
              strokes={strokes}
              onStrokesChange={setStrokes}
            />

            {/* Absolute end of the page: the chat bar is the last element, full
                width, where every chat input lives. */}
            <ChatBar
              busy={render.busy}
              hasPaint={strokes.length > 0}
              onSubmit={(p) => void handlePrompt(p)}
            />
          </>
        )}
      </main>

      {/* Direct child of the h-screen row: the panel gets a definite height to
          scroll within, no wrapper div in the chain to break it. */}
      <HistoryPanel
        renders={history}
        loading={historyLoading}
        activeId={activeId}
        collapsed={!historyOpen}
        onToggleCollapsed={() => setHistoryOpen((v) => !v)}
        onSelect={(id) => void makeActive(id)}
        onDelete={(id) => void handleDelete(id)}
      />

      {toast && (
        <div className="fixed bottom-20 left-1/2 z-50 max-w-[min(560px,90vw)] -translate-x-1/2 rounded-card border border-hairline bg-panel px-4 py-3 text-[13px] leading-[1.45] text-ink shadow-lift">
          {toast}
        </div>
      )}
    </div>
  );
}

function HeaderButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: `disabled` derives from async-loaded state
    // (surfaces, history), so a dev-server rebuild racing an open page can
    // serve HTML whose snapshot disagrees with the first client render. The
    // attribute self-corrects on the next render either way.
    <button
      onClick={onClick}
      disabled={disabled}
      suppressHydrationWarning
      className="flex h-9 items-center gap-[7px] rounded-lg px-2.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:bg-pine-tint hover:text-pine disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HeaderToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      suppressHydrationWarning
      className={`flex h-9 items-center gap-[7px] rounded-lg px-2.5 text-[12.5px] font-medium transition-colors ${
        active ? "bg-pine-tint text-pine" : "text-ink-soft hover:bg-pine-tint hover:text-pine"
      }`}
    >
      {children}
    </button>
  );
}

