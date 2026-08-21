import Link from "next/link";

/**
 * Workspace chrome — one slim bar for the signed-in pages (rooms, new room,
 * project). The editor keeps its own focused header; this is for everywhere
 * else in the app.
 */
export function AppHeader({ credits }: { credits: number }) {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-porcelain/85 backdrop-blur-[8px]">
      <div className="mx-auto flex h-[58px] w-full max-w-6xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" aria-label="roomvi workspace" className="flex items-center gap-[9px]">
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
          </Link>

          <nav aria-label="Workspace" className="hidden items-center gap-5 sm:flex">
            {[
              ["/dashboard", "Rooms"],
              ["/new", "New room"],
              ["/materials", "Materials"],
              ["/pricing", "Plan & billing"],
            ].map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="text-[12.5px] font-medium text-ink-soft transition-colors hover:text-pine"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Credits, always visible: a balance the user cannot see is a render
            that surprises them at submit time. */}
        <div className="flex items-center gap-2 rounded-full border border-hairline bg-panel py-1 pl-2.5 pr-3 shadow-card">
          <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-pine-tint text-pine" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-2.5 w-2.5">
              <path d="M12 5v14M6.5 8.5h11M6.5 15.5h11" />
            </svg>
          </span>
          <span className="text-[11.5px] font-semibold tabular-nums text-ink">{credits}</span>
          <span className="text-[11px] text-ink-faint">credits</span>
        </div>
      </div>
    </header>
  );
}
