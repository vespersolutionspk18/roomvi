"use client";

/**
 * The chat bar — the last thing on the page, the way every chat input works.
 *
 * One sentence is the whole interface: what to change, aimed by the selected
 * label, dressed with whatever references are picked. Enter sends; the busy
 * state lives in the stage scrim.
 */
import { useRef, useState } from "react";
import type { Zone } from "@/lib/editor/types";

type Props = {
  zones: Zone[];
  selectedZoneId: string | null;
  busy: boolean;
  /** A painted region is waiting — the sentence should describe what goes IN it. */
  hasPaint?: boolean;
  onSubmit: (prompt: string) => void;
};

export function ChatBar({ zones, selectedZoneId, busy, hasPaint = false, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selectedZone = zones.find((z) => z.id === selectedZoneId) ?? null;

  const send = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSubmit(text);
    setValue("");
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-2.5 rounded-card border border-hairline bg-panel py-2 pl-3 pr-2 shadow-lift">
      {/* What the sentence will be aimed at — visible where it is formed, not in
          a panel the eye has left. */}
      {selectedZone && (
        <span className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-full bg-pine-tint px-2.5 text-[11px] font-semibold text-pine">
          <span
            className="h-[6px] w-[6px] rounded-full"
            style={{ background: `rgb(${selectedZone.tint.join(",")})` }}
          />
          {selectedZone.label}
        </span>
      )}

      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Grow with the content, cap at three lines — a chat bar, not a form.
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 66)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          hasPaint
            ? "What should appear in the painted area?"
            : selectedZone
              ? `Change the ${selectedZone.label.toLowerCase()}…`
              : "Describe the change…"
        }
        aria-label="Describe the change"
        disabled={busy}
        className="max-h-[66px] min-h-[28px] w-full resize-none border-none bg-transparent py-1 text-[13px] leading-snug text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
      />

      <button
        onClick={send}
        disabled={busy || !value.trim()}
        aria-label="Render this change"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-pine text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark disabled:pointer-events-none disabled:bg-[#B8C3BE] disabled:shadow-none"
      >
        {busy ? (
          <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="M5 12h13" />
            <path d="m13 7 5 5-5 5" />
          </svg>
        )}
      </button>
    </div>
  );
}
