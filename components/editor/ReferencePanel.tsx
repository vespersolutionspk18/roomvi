"use client";

/**
 * The left panel: what the edit is aimed at, and what it should look like.
 *
 * References are the whole point of the simplified editor. A sentence says what
 * to change; a reference says what it should become — a cupboard photo, a
 * material sample, a colour plate. Pick from the library or upload your own;
 * everything selected travels to the model alongside the room photo.
 */
import { useEffect, useRef, useState } from "react";
import type { Zone } from "@/lib/editor/types";

export type Reference = { key: string; url: string; source: "library" | "upload"; name: string };

type LibraryItem = { id: string; name: string; heroUrl: string | null };

/** Hard cap. The Pro editor accepts many more, but past a handful the model
    starts averaging references instead of following them. */
const MAX_REFERENCES = 3;

type Props = {
  zones: Zone[];
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  references: Reference[];
  onToggleReference: (ref: Reference) => void;
  onUploadReference: (file: File) => Promise<void>;
  uploading: boolean;
  disabled?: boolean;
};

export function ReferencePanel({
  zones,
  selectedZoneId,
  onSelectZone,
  references,
  onToggleReference,
  onUploadReference,
  uploading,
  disabled = false,
}: Props) {
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;

  useEffect(() => {
    fetch("/api/materials")
      .then((r) => r.json())
      .then((d) => setLibrary(d.materials ?? []))
      .catch(() => setLibrary([]));
  }, []);

  const full = references.length >= MAX_REFERENCES;

  return (
    <aside className="flex w-[264px] flex-shrink-0 flex-col gap-4 bg-panel px-[18px] pb-[14px] pt-[18px] shadow-[1px_0_0_var(--color-hairline)]">
      <div className="flex items-center gap-[9px]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[24px] w-[24px] text-pine"
          aria-hidden="true"
        >
          <path d="M3 8V6a3 3 0 0 1 3-3h2" />
          <path d="M16 3h2a3 3 0 0 1 3 3v2" />
          <path d="M21 16v2a3 3 0 0 1-3 3h-2" />
          <path d="M8 21H6a3 3 0 0 1-3-3v-2" />
          <rect x="8.5" y="8.5" width="7" height="7" rx="1.6" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
        <span className="font-display text-[19px] font-[560] tracking-[-.01em] text-ink">
          room<em className="not-italic text-brass">vi</em>
        </span>
      </div>

      {/* target */}
      <div
        className={`rounded-[9px] border px-3 py-2 transition-colors ${
          selectedZone ? "border-pine bg-pine-tint" : "border-hairline bg-[#FBFAF7]"
        }`}
      >
        <div className="text-[12px] font-semibold text-ink-faint">Change what?</div>
        <div className="mt-1 flex items-center gap-2">
          {selectedZone ? (
            <>
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: `rgb(${selectedZone.tint.join(",")})` }}
              />
              <span className="truncate text-[13px] font-semibold text-ink">{selectedZone.label}</span>
              <button
                onClick={() => onSelectZone(null)}
                className="ml-auto text-[11px] font-medium text-pine hover:text-pine-dark"
              >
                Whole room
              </button>
            </>
          ) : (
            <span className="text-[12.5px] text-ink-faint">
              The whole room — click a label to aim
            </span>
          )}
        </div>
      </div>

      {/* selected references */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-semibold text-ink-faint">Look like this</span>
          <span className="text-[11px] text-ink-faint tabular-nums">
            {references.length}/{MAX_REFERENCES}
          </span>
        </div>

        {references.length === 0 && (
          <p className="rounded-lg bg-porcelain px-3 py-2.5 text-[11.5px] leading-snug text-ink-soft">
            Optional. Add a photo of the thing you want — green cupboards, oak floor,
            whatever it should look like.
          </p>
        )}

        <div className="grid grid-cols-3 gap-2">
          {references.map((r) => (
            <div
              key={r.key}
              className="group relative aspect-square overflow-hidden rounded-[9px] border border-pine shadow-[0_0_0_1px_var(--color-pine)]"
              title={r.name}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.url} alt={r.name} className="h-full w-full object-cover" />
              <button
                onClick={() => onToggleReference(r)}
                aria-label={`Remove ${r.name}`}
                className="absolute right-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-white/95 text-[11px] font-semibold leading-none text-ink shadow-card transition-colors hover:bg-white"
              >
                ×
              </button>
            </div>
          ))}

          {!full && (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploading}
              title="Upload your own reference"
              className={`grid aspect-square place-items-center rounded-[9px] border border-dashed transition-colors ${
                disabled || uploading
                  ? "border-hairline opacity-40"
                  : "border-hairline text-ink-faint hover:border-pine hover:text-pine"
              }`}
            >
              {uploading ? (
                <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin text-pine" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
                  <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              )}
            </button>
          )}
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onUploadReference(file);
          }}
        />
      </div>

      {/* library */}
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <span className="text-[12px] font-semibold text-ink-faint">From the library</span>
        <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto pb-2 pr-0.5">
          {library.map((m) => {
            const active = m.heroUrl != null && references.some((r) => r.key === heroKeyOf(m));
            return (
              <button
                key={m.id}
                onClick={() =>
                  m.heroUrl &&
                  onToggleReference({
                    key: heroKeyOf(m),
                    url: m.heroUrl,
                    source: "library",
                    name: m.name,
                  })
                }
                disabled={!m.heroUrl || (full && !active)}
                title={`${m.name}${active ? " — selected" : ""}`}
                className={`relative aspect-square overflow-hidden rounded-[9px] border transition-all duration-150 ${
                  active
                    ? "border-pine shadow-[0_0_0_1px_var(--color-pine)]"
                    : "border-hairline hover:-translate-y-0.5 hover:border-pine disabled:pointer-events-none disabled:opacity-40"
                }`}
              >
                {m.heroUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.heroUrl} alt={m.name} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="h-full w-full bg-hairline" />
                )}
                <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-[rgb(20_20_16/0.7)] to-transparent px-1 pb-0.5 pt-3 text-left text-[9px] font-medium text-white">
                  {m.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/** The library's storage key lives at the end of its own /api/files URL. */
function heroKeyOf(m: LibraryItem): string {
  return m.heroUrl?.split("/api/files/")[1] ?? m.id;
}
