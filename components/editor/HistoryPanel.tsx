"use client";

/**
 * Version history — the right rail.
 *
 * Every render hangs off the ORIGINAL photo, so any version can be made active
 * without generation loss. Clicking a version makes it the one on stage — and
 * the canvas for whatever is typed next. A finished render becomes active on
 * arrival; stepping back is one click, which is all the undo a history of
 * complete versions needs.
 */
import type { RenderSummary } from "@/lib/editor/types";

type Props = {
  renders: RenderSummary[];
  loading: boolean;
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
};

export function HistoryPanel({
  renders,
  loading,
  activeId,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onDelete,
}: Props) {
  if (collapsed) {
    return (
      <button
        onClick={onToggleCollapsed}
        title="Show version history"
        className="my-3.5 mr-[18px] flex w-[46px] flex-shrink-0 flex-col items-center gap-2 self-start rounded-card border border-hairline bg-panel py-3 shadow-card transition-colors hover:border-pine"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px] text-pine" aria-hidden="true">
          <path d="M4 12a8 8 0 1 1 2.3 5.6" />
          <path d="M4 13.5V9h4.5" opacity="0" />
          <path d="M4.5 10.5H9V6" />
          <path d="M12 8v4.5l3 1.8" />
        </svg>
        {renders.length > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-pine-tint px-1 text-[10px] font-semibold tabular-nums text-pine">
            {renders.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="my-3.5 mr-[18px] flex min-h-0 w-[236px] flex-shrink-0 flex-col gap-3 rounded-card border border-hairline bg-panel p-3 shadow-card">
      <div className="flex items-center justify-between px-1">
        <span className="text-[12px] font-semibold text-ink">
          Versions{" "}
          {!loading && (
            <span className="font-normal text-ink-faint">({renders.length})</span>
          )}
        </span>
        <button
          onClick={onToggleCollapsed}
          title="Collapse"
          aria-label="Collapse version history"
          className="grid h-6 w-6 place-items-center rounded-md text-ink-faint transition-colors hover:bg-pine-tint hover:text-pine"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>

      {/* THE list. flex-1 + min-h-0 inside a definite-height column: this is the
          pair that makes overflow-y-auto actually scroll rather than clip. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pr-0.5">
        {loading && (
          <div className="py-6 text-center text-[11.5px] text-ink-faint">Loading…</div>
        )}
        {!loading && renders.length === 0 && (
          <p className="px-1 py-4 text-[11.5px] leading-relaxed text-ink-faint">
            Renders land here. Every version stays addressable against the original
            photo, so nothing is ever lost by trying something.
          </p>
        )}

        {renders.map((r) => {
          const isActive = r.id === activeId;
          const thumb = r.url;
          const failed = r.status === "failed";
          const selectable = !failed && Boolean(thumb);
          return (
            // A div, not a button: the card contains the delete button, and
            // HTML forbids nesting interactive elements inside <button>.
            <div
              key={r.id}
              role="button"
              tabIndex={selectable ? 0 : -1}
              aria-disabled={!selectable}
              onClick={() => {
                if (selectable) onSelect(r.id);
              }}
              onKeyDown={(e) => {
                if (selectable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onSelect(r.id);
                }
              }}
              title={describe(r)}
              className={`group relative shrink-0 cursor-pointer overflow-hidden rounded-[9px] border text-left transition-all duration-150 ${
                isActive
                  ? "border-pine shadow-[0_0_0_1px_var(--color-pine)]"
                  : "border-hairline hover:border-pine aria-disabled:pointer-events-none aria-disabled:opacity-45"
              }`}
            >
              <div className="relative aspect-[16/9] overflow-hidden bg-porcelain">
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="absolute inset-0 grid place-items-center text-[10.5px] text-ink-faint">
                    {failed ? "Failed" : r.status}
                  </span>
                )}
                {isActive && (
                  <span className="absolute left-1.5 top-1.5 flex h-[20px] items-center gap-1 rounded-full bg-white/95 px-2 text-[9.5px] font-semibold text-pine shadow-card">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-2 w-2" aria-hidden="true">
                      <path d="M4.5 12.5l5 5 10-11" />
                    </svg>
                    Active
                  </span>
                )}
                {onDelete && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(r.id);
                    }}
                    aria-label={`Delete version from ${when(r.createdAt)}`}
                    title="Delete this version"
                    className="absolute right-1.5 top-1.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-white/95 text-ink-soft opacity-0 shadow-card transition-all duration-150 hover:bg-white hover:text-[rgb(160_45_70)] group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                      <path d="m6 6 12 12M18 6 6 18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="px-2 py-1.5">
                <div className="truncate text-[11px] font-medium text-ink">{describe(r)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[9.5px] text-ink-faint">
                  <span>{shortModel(r.executor, r.model)}</span>
                  <span className="h-[3px] w-[3px] rounded-full bg-brass opacity-70" />
                  <span>{when(r.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function describe(r: RenderSummary): string {
  const op = r.ops[0];
  if (!op) return "Edit";
  if (op.kind === "prompt" && op.prompt) {
    const t = op.prompt.trim();
    return t.length > 42 ? `${t.slice(0, 42)}…` : t;
  }
  if (op.kind === "material") {
    return "Material swap";
  }
  return "Edit";
}

function shortModel(executor: string, model: string | null): string {
  if (executor === "precision") return "True scale";
  if (model?.includes("pro")) return "Pro";
  if (model?.includes("nano-banana")) return "Flash";
  return "Generative";
}

function when(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
