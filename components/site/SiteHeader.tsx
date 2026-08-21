import Link from "next/link";

/**
 * Marketing chrome — the showroom's `.site-head`, ported.
 *
 * Shown on the public pages (landing, materials, pricing). The workspace has its
 * own slimmer header, because someone mid-argument with a countertop does not
 * need a second navigation philosophy.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-porcelain/85 backdrop-blur-[8px]">
      <div className="mx-auto flex h-[64px] w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" aria-label="roomvi home" className="flex items-center gap-[9px]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[26px] w-[26px] text-pine"
            aria-hidden="true"
          >
            <path d="M3 8V6a3 3 0 0 1 3-3h2" />
            <path d="M16 3h2a3 3 0 0 1 3 3v2" />
            <path d="M21 16v2a3 3 0 0 1-3 3h-2" />
            <path d="M8 21H6a3 3 0 0 1-3-3v-2" />
            <rect x="8.5" y="8.5" width="7" height="7" rx="1.6" />
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          </svg>
          <span className="font-display text-[21px] font-[560] tracking-[-.01em] text-ink">
            room<em className="not-italic text-brass">vi</em>
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {[
            ["/", "Product"],
            ["/materials", "Materials"],
            ["/pricing", "Pricing"],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="text-[13px] font-medium text-ink-soft transition-colors hover:text-pine"
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="hidden h-9 items-center text-[13px] font-medium text-ink-soft transition-colors hover:text-pine sm:flex"
          >
            Open workspace
          </Link>
          <Link
            href="/new"
            className="flex h-9 items-center gap-2 rounded-[9px] bg-pine px-4 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
          >
            Start visualising
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
              <path d="M5 12h13" />
              <path d="m13 7 5 5-5 5" />
            </svg>
          </Link>
        </div>
      </div>
    </header>
  );
}
