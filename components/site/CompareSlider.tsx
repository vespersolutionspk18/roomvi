"use client";

/**
 * Before/after compare — the project page's `.compare` and the landing hero's
 * proof, merged into one component.
 *
 * Pointer-driven rather than a hidden range input: the whole frame is the track,
 * which is how every compare slider users have met behaves. The seam is a pure
 * CSS clip on the after layer, so there is no resampling and no seam artefact.
 */
import { useRef, useState } from "react";

type Props = {
  beforeUrl: string;
  afterUrl: string;
  /** Label chips over each side. */
  beforeLabel?: string;
  afterLabel?: string;
  /** Initial seam position, 0-1. */
  initial?: number;
  className?: string;
};

export function CompareSlider({
  beforeUrl,
  afterUrl,
  beforeLabel = "Original",
  afterLabel = "Rendered",
  initial = 0.55,
  className = "",
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [x, setX] = useState(initial);

  const setFromClientX = (clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setX(Math.min(0.96, Math.max(0.04, (clientX - rect.left) / rect.width)));
  };

  return (
    <div
      ref={frameRef}
      className={`relative select-none overflow-hidden rounded-card border border-hairline shadow-lift ${className}`}
      style={{ cursor: "ew-resize", touchAction: "none" }}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) setFromClientX(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={beforeUrl} alt={beforeLabel} className="block w-full object-cover" draggable={false} />

      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${x * 100}%)` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={afterUrl}
          alt={afterLabel}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      </div>

      {/* The seam. Above both layers; the handle rides it. */}
      <div
        className="pointer-events-none absolute inset-y-0 w-[2px] bg-white shadow-[0_0_0_1px_rgb(25_25_23/0.14),0_0_24px_rgb(25_25_22/0.3)]"
        style={{ left: `${x * 100}%` }}
      />
      <div
        className="pointer-events-none absolute top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-hairline bg-white text-pine shadow-lift"
        style={{ left: `${x * 100}%` }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="m9 7-5 5 5 5" />
          <path d="m15 7 5 5-5 5" />
        </svg>
      </div>

      {[
        [beforeLabel, "left-3", "bg-[rgb(25_25_22/0.55)] text-white"],
        [afterLabel, "right-3", "bg-white/95 text-ink"],
      ].map(([label, side, tone]) => (
        <span
          key={label}
          className={`pointer-events-none absolute top-3 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold backdrop-blur-[6px] ${side} ${tone}`}
        >
          <span className={`h-[6px] w-[6px] rounded-full ${label === beforeLabel ? "bg-[#B8B2A4]" : "bg-brass"}`} />
          {label}
        </span>
      ))}
    </div>
  );
}
