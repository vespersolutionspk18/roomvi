"use client";

/**
 * Copy-the-link button with honest state. The clipboard API needs a secure
 * context, so localhost gets the fallback path too — a button that silently
 * does nothing on http dev servers is worse than document.execCommand.
 */
import { useState } from "react";

export function CopyLink({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = url;
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand("copy");
        el.remove();
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <button
      onClick={copy}
      className="flex h-9 items-center gap-2 rounded-[9px] border border-hairline bg-panel px-3.5 text-[12px] font-semibold text-ink-soft transition-colors hover:border-pine hover:text-pine"
    >
      {copied ? (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-pine" aria-hidden="true">
            <path d="M4.5 12.5l5 5 10-11" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
            <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
            <path d="M15.5 8.5V7a2.5 2.5 0 0 0-2.5-2.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}
