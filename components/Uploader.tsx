"use client";

/**
 * Upload — the entry point. Ports `showroom/new-room.html`'s dropzone and photo
 * checklist, wired to POST /api/uploads.
 *
 * The checklist is not decoration: `lib/image.ts` enforces exactly what it asks
 * for. A blown-out surface is a HARD reject there (no shading signal means any
 * composite looks pasted on), so the quality warnings this surfaces are the same
 * measurements the render path will act on.
 *
 * A `reject` verdict still uploads. The user keeps the photo and the explanation
 * rather than losing the bytes and re-sending them.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Quality = {
  verdict: "ok" | "warn" | "reject";
  warnings: string[];
  blurVariance: number;
  clippedLowPct: number;
  clippedHighPct: number;
};

type UploadedImage = {
  id: string;
  width: number;
  height: number;
  displayWidth: number | null;
  displayHeight: number | null;
  quality: Quality | null;
  url: string | null;
};

export function Uploader() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadedImage | null>(null);

  /**
   * A project is required before an upload can be attributed, so resolve or
   * create one on mount. Reusing the newest project means repeat uploads land
   * together instead of spawning a project per photo.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/projects");
        const data = await res.json();
        if (cancelled) return;
        if (data.projects?.length > 0) {
          setProjectId(data.projects[0].id);
          return;
        }
        const created = await fetch("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "My first room" }),
        }).then((r) => r.json());
        if (!cancelled) setProjectId(created.project?.id ?? null);
      } catch {
        if (!cancelled) setError("Could not reach the server. Is the dev server running?");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(
    async (file: File) => {
      if (!projectId) {
        setError("Still setting up your project — try again in a moment.");
        return;
      }
      setBusy(true);
      setError(null);
      setResult(null);

      try {
        const form = new FormData();
        form.append("file", file);
        form.append("projectId", projectId);

        const res = await fetch("/api/uploads", { method: "POST", body: form });
        const data = await res.json();

        if (!res.ok) {
          setError(data.error?.message ?? "Upload failed.");
          return;
        }
        setResult(data.image);
      } catch {
        setError("Upload failed — the server did not respond.");
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  };

  const verdict = result?.quality?.verdict;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-14">
      <header className="flex flex-col gap-2">
        <span className="text-[12px] font-semibold text-ink-faint">
          New room
        </span>
        <h1 className="font-display text-[34px] font-[560] leading-[1.1] tracking-[-.015em] text-ink">
          Start with one photo
        </h1>
        <p className="max-w-xl text-[14px] leading-relaxed text-ink-soft">
          We detect the floor, walls, ceiling, worktops, backsplash, cabinets and windows once, then
          reuse those zones for every material you try.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`flex min-h-[280px] cursor-pointer flex-col items-center justify-center gap-4 rounded-card border-2 border-dashed bg-panel p-8 text-center transition-colors ${
              dragging ? "border-pine bg-pine-tint" : "border-hairline hover:border-brass"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
              }}
            />

            {busy ? (
              <>
                <svg viewBox="0 0 24 24" className="h-8 w-8 animate-spin text-pine" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
                  <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
                <div className="font-display text-[19px] font-[560] text-ink">Reading the room…</div>
              </>
            ) : (
              <>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-9 w-9 text-pine"
                  aria-hidden="true"
                >
                  <path d="M12 16V5.5" />
                  <path d="M8 9.5 12 5.5l4 4" />
                  <path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
                </svg>
                <div className="flex flex-col gap-1">
                  <div className="font-display text-[21px] font-[560] text-ink">
                    Drop a room photo
                  </div>
                  <div className="text-[12.5px] text-ink-soft">
                    JPEG, PNG, WebP or HEIC · up to 32MB
                  </div>
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="rounded-card border border-[rgb(200_60_90/0.3)] bg-[rgb(200_60_90/0.06)] px-4 py-3 text-[13px] text-[rgb(150_40_65)]">
              {error}
            </div>
          )}

          {result && (
            <div className="flex flex-col gap-4 rounded-card border border-hairline bg-panel p-4 shadow-card">
              <div className="flex gap-4">
                {result.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.url}
                    alt="Uploaded room"
                    className="h-24 w-32 flex-shrink-0 rounded-lg border border-hairline object-cover"
                  />
                )}
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex h-[19px] items-center rounded-full px-2 text-[10px] font-semibold ${
                        verdict === "ok"
                          ? "bg-pine-tint text-pine"
                          : verdict === "warn"
                            ? "bg-brass-tint text-brass"
                            : "bg-[rgb(200_60_90/0.12)] text-[rgb(160_45_70)]"
                      }`}
                    >
                      {verdict === "ok" ? "Good to go" : verdict === "warn" ? "Usable" : "Poor quality"}
                    </span>
                    <span className="text-[12px] text-ink-faint">
                      {result.displayWidth}×{result.displayHeight}
                    </span>
                  </div>

                  {result.quality?.warnings.length ? (
                    <ul className="flex flex-col gap-1">
                      {result.quality.warnings.map((w) => (
                        <li key={w} className="text-[12.5px] leading-snug text-ink-soft">
                          · {w}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[12.5px] text-ink-soft">
                      Sharp, well exposed, plenty of visible surface.
                    </div>
                  )}
                </div>
              </div>

              <button
                onClick={() => router.push(`/editor/${result.id}`)}
                className="flex h-11 items-center justify-center gap-2 rounded-[9px] bg-pine px-5 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-colors hover:bg-pine-dark"
              >
                Detect surfaces
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M5 12h13" />
                  <path d="m13 7 5 5-5 5" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* The checklist from new-room.html:272-289. Each line maps to a real check
            in lib/image.ts — this is what the gate measures, not general advice. */}
        <aside className="flex h-fit flex-col gap-3 rounded-card border border-hairline bg-panel p-4 shadow-card">
          <span className="text-[12px] font-semibold text-ink-faint">
            Photo checklist
          </span>
          <h3 className="font-display text-[17px] font-[560] leading-snug text-ink">
            Five seconds of care, a much better render
          </h3>
          {[
            ["Hold the phone parallel to the wall.", "Skewed angles stretch the grain and skew the scale."],
            ["Shoot in daylight, no flash.", "A blown-out surface has no shading to transfer, so a swap looks pasted."],
            ["Keep legs, boxes and pets out of frame.", "The more surface visible, the larger the swappable area."],
          ].map(([bold, rest]) => (
            <div key={bold} className="flex gap-2.5">
              <span className="mt-0.5 grid h-[17px] w-[17px] flex-shrink-0 place-items-center rounded-full bg-pine text-white">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-2.5 w-2.5"
                  aria-hidden="true"
                >
                  <path d="M4.5 12.5l5 5 10-11" />
                </svg>
              </span>
              <span className="text-[12.5px] leading-snug text-ink-soft">
                <b className="font-semibold text-ink">{bold}</b> {rest}
              </span>
            </div>
          ))}
          <div className="mt-1 rounded-lg bg-porcelain px-3 py-2.5 text-[12px] leading-snug text-ink-soft">
            <b className="font-semibold text-ink">Pro tip:</b> stand about 2 metres back for floors,
            1.5 m for worktops.
          </div>
        </aside>
      </div>
    </div>
  );
}
