import Link from "next/link";

/** Shared footer for the public pages. */
export function SiteFooter() {
  return (
    <footer className="border-t border-hairline bg-panel">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-[9px]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 text-pine"
            aria-hidden="true"
          >
            <path d="M3 8V6a3 3 0 0 1 3-3h2" />
            <path d="M16 3h2a3 3 0 0 1 3 3v2" />
            <path d="M21 16v2a3 3 0 0 1-3 3h-2" />
            <path d="M8 21H6a3 3 0 0 1-3-3v-2" />
            <rect x="8.5" y="8.5" width="7" height="7" rx="1.6" />
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          </svg>
          <span className="font-display text-[16px] font-[560] text-ink">
            room<em className="not-italic text-brass">vi</em>
          </span>
        </div>

        <nav aria-label="Footer" className="flex items-center gap-6">
          {[
            ["/materials", "Materials"],
            ["/pricing", "Pricing"],
            ["/new", "Start a room"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="text-[12px] text-ink-soft transition-colors hover:text-pine"
            >
              {label}
            </Link>
          ))}
        </nav>

        <span className="text-[11.5px] text-ink-faint">See it before you commit.</span>
      </div>
    </footer>
  );
}
