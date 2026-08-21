"use client";

/**
 * The stage: the photo, the labels, the paint brush, and the result.
 *
 * Detection still runs once per photo — its LABELS are how the user aims an
 * edit ("the cupboards") without typing a paragraph. The paint layer is how
 * they aim at something detection has no word for: strokes become a mask that
 * both guides the model and, composited afterwards, contains it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaintStroke } from "@/lib/editor/types";

type Props = {
  imageUrl: string | null;
  width: number;
  height: number;

  /** A finished render to show over the photo. Null shows the photo alone. */
  renderUrl?: string | null;
  /** Shown over the stage while a render is in flight. */
  busyNote?: string | null;
  /** Present when the editor can dismiss the render and return to the photo. */
  onBackToPhoto?: () => void;
  /** Paint mode on: the pointer becomes a brush and labels step aside. */
  paintMode?: boolean;
  strokes: PaintStroke[];
  onStrokesChange: (strokes: PaintStroke[]) => void;
};

const MIN_RADIUS = 0.006;
const MAX_RADIUS = 0.09;

export function Stage({
  imageUrl,
  width,
  height,

  renderUrl = null,
  busyNote = null,
  onBackToPhoto,
  paintMode = false,
  strokes,
  onStrokesChange,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Wipe position, 0-1. Only meaningful while a render is displayed. */
  const [wipe, setWipe] = useState(1);
  const dragging = useRef(false);

  // Painting state. `current` is the in-flight stroke; version bumps redraw.
  const current = useRef<PaintStroke | null>(null);
  const [tool, setTool] = useState<"add" | "erase">("add");
  const [radius, setRadius] = useState(0.03);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [version, setVersion] = useState(0);

  // A new render resets the wipe to fully-revealed. Adjusted during render, not
  // in an effect, so there is no frame where the new render sits under the old
  // wipe position.
  const [wipedUrl, setWipedUrl] = useState(renderUrl);
  if (renderUrl !== wipedUrl) {
    setWipedUrl(renderUrl);
    setWipe(1);
  }

  const showing = Boolean(renderUrl) && !paintMode;
  const painting = paintMode;

  /** Pointer position as normalized display coordinates. */
  const normalize = useCallback(
    (e: React.PointerEvent | React.MouseEvent) => {
      const img = frameRef.current?.querySelector("img");
      const rect = img?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    },
    [],
  );

  /* --------------------------------------------------------- paint drawing */

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    ctx.clearRect(0, 0, cw, ch);
    // Over a finished render the strokes disappear entirely — they belong to
    // the photo, and ghost marks on a render read as defects.
    if (showing || (!painting && strokes.length === 0)) return;

    // The overlay is a MARKING, not the mask that ships: translucent green so
    // the room stays visible underneath. Erase punches back through to the
    // photo (destination-out), which is why add and erase are drawn as separate
    // passes in stroke order.
    const shortEdge = Math.min(cw, ch);
    const paintStroke = (stroke: PaintStroke) => {
      const r = stroke.radius * shortEdge;
      ctx.globalCompositeOperation =
        stroke.mode === "erase" ? "destination-out" : "source-over";
      ctx.fillStyle = "rgb(74 222 128 / 0.5)";
      const pts = stroke.points.map((p) => ({ x: p.x * cw, y: p.y * ch }));
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) {
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        const a = pts[i - 1];
        const b = pts[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    // Committed strokes stay faintly visible after paint mode closes — an area
    // the user marked and then cannot see is a surprise waiting to render.
    ctx.globalAlpha = painting ? 1 : 0.4;
    for (const stroke of strokes) paintStroke(stroke);
    if (current.current) {
      ctx.globalAlpha = 1;
      paintStroke(current.current);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }, [painting, showing, strokes]);

  useEffect(() => {
    redraw();
  }, [redraw, version]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(frame);
    return () => ro.disconnect();
  }, [redraw]);

  const onPaintDown = (e: React.PointerEvent) => {
    if (!painting) return;
    const p = normalize(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = { mode: tool, radius, points: [p] };
    setVersion((v) => v + 1);
  };

  const onPaintMove = (e: React.PointerEvent) => {
    const p = normalize(e);
    setCursor(p);
    if (!current.current || !p) return;
    current.current.points.push(p);
    setVersion((v) => v + 1);
  };

  const onPaintUp = (e: React.PointerEvent) => {
    if (!current.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const stroke = current.current;
    current.current = null;
    onStrokesChange([...strokes, stroke]);
    setVersion((v) => v + 1);
  };

  /* ----------------------------------------------------------------- view */

  return (
    <div
      ref={frameRef}
      className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-hairline bg-porcelain shadow-card"
    >
      {/* aspect-ratio box: keeps every overlay in lockstep with the photo. */}
      <div className="absolute inset-0 grid place-items-center">
        <div
          className="relative max-h-full max-w-full"
          style={{ aspectRatio: `${width} / ${height}`, width: "100%" }}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt="Room photo"
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-sm text-ink-faint">
              No photo
            </div>
          )}

          {/* The render, clipped to the wipe. Layered OVER the photo so the
              comparison needs no second decode and the boundary is a pure CSS
              clip — no seam, no resampling. */}
          {renderUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={renderUrl}
              alt="Render"
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)` }}
              draggable={false}
            />
          )}

          <canvas
            ref={canvasRef}
            onPointerDown={onPaintDown}
            onPointerMove={onPaintMove}
            onPointerUp={onPaintUp}
            onPointerLeave={() => {
              setCursor(null);
              // A stroke that ends off-canvas is still a stroke the user drew.
              if (current.current) {
                const stroke = current.current;
                current.current = null;
                onStrokesChange([...strokes, stroke]);
                setVersion((v) => v + 1);
              }
            }}
            className="absolute inset-0 h-full w-full touch-none"
            style={{
              cursor: painting ? "none" : "default",
              // The canvas only takes pointers while painting; otherwise chips
              // and the wipe handle own the stage.
              pointerEvents: painting ? "auto" : "none",
            }}
          />

          {/* Brush cursor. The ring IS the cursor while painting. */}
          {painting && cursor && (
            <div
              className={`pointer-events-none absolute rounded-full border-2 ${
                tool === "add" ? "border-white" : "border-[#E0574F]"
              }`}
              style={{
                left: `${cursor.x * 100}%`,
                top: `${cursor.y * 100}%`,
                width: `${radius * 100 * (width >= height ? height / width : 1) * 2}%`,
                height: `${radius * 100 * (width >= height ? 1 : width / height) * 2}%`,
                transform: "translate(-50%, -50%)",
                boxShadow: "0 0 0 1px rgb(25 25 22 / .45), inset 0 0 0 1px rgb(25 25 22 / .45)",
              }}
            />
          )}


          {/* Paint toolbar. Top-centre, where the hand already is. */}
          {painting && (
            <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-hairline bg-panel/95 px-2 py-1.5 shadow-lift backdrop-blur-[6px]">
              <span className="pl-1 pr-1 text-[11.5px] font-semibold text-ink">Paint where the change goes</span>
              <div className="h-5 w-px bg-hairline" />
              <button
                onClick={() => setTool("add")}
                className={`flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-colors ${
                  tool === "add" ? "bg-pine text-white" : "text-ink-soft hover:bg-pine-tint hover:text-pine"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M15.2 5.6l3.2 3.2-8.1 8.1-4 .8.8-4 8.1-8.1Z" />
                </svg>
                Brush
              </button>
              <button
                onClick={() => setTool("erase")}
                className={`flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-colors ${
                  tool === "erase" ? "bg-pine text-white" : "text-ink-soft hover:bg-pine-tint hover:text-pine"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M8.5 12h7M12 8.5v7" opacity="0" />
                  <path d="M16.8 4.8l2.4 2.4-9.6 9.6H5.2v-4.4z" />
                </svg>
                Erase
              </button>
              <div className="h-5 w-px bg-hairline" />
              <label className="flex items-center gap-1.5 px-1" title="Brush size">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={Math.log(radius / MIN_RADIUS) / Math.log(MAX_RADIUS / MIN_RADIUS)}
                  onChange={(e) =>
                    setRadius(MIN_RADIUS * (MAX_RADIUS / MIN_RADIUS) ** Number(e.target.value))
                  }
                  className="h-1 w-20 accent-pine"
                />
              </label>
              <div className="h-5 w-px bg-hairline" />
              <button
                onClick={() => onStrokesChange(strokes.slice(0, -1))}
                disabled={strokes.length === 0}
                className="flex h-7 items-center rounded-md px-2 text-[11.5px] font-medium text-ink-soft transition-colors hover:bg-pine-tint hover:text-pine disabled:pointer-events-none disabled:opacity-35"
              >
                Undo
              </button>
              <button
                onClick={() => onStrokesChange([])}
                disabled={strokes.length === 0}
                className="flex h-7 items-center rounded-md px-2 text-[11.5px] font-medium text-ink-soft transition-colors hover:bg-pine-tint hover:text-pine disabled:pointer-events-none disabled:opacity-35"
              >
                Clear
              </button>
            </div>
          )}

          {/* Inner vignette. */}
          <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_90px_rgb(25_25_22/0.10)]" />
        </div>
      </div>

      {/* In-flight note. A scrim, not a spinner over a blank box: the photo stays
          visible because the user is waiting to see it CHANGE. */}
      {busyNote && (
        <div className="absolute inset-0 grid place-items-center bg-porcelain/45 backdrop-blur-[1px]">
          <div className="flex items-center gap-2.5 rounded-full border border-hairline bg-white/95 px-4 py-2 text-[12.5px] font-medium text-ink shadow-lift">
            <span
              className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-hairline border-t-pine"
              aria-hidden="true"
            />
            {busyNote}
          </div>
        </div>
      )}

      {/* Compare wipe. Pointer events across the whole stage, like every compare
          slider users have met. */}
      {showing && (
        <div
          className="absolute inset-0 cursor-ew-resize"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            const pos = normalize(e);
            if (pos) setWipe(Math.min(1, Math.max(0, pos.x)));
          }}
          onPointerMove={(e) => {
            if (!dragging.current) return;
            const pos = normalize(e);
            if (pos) setWipe(Math.min(1, Math.max(0, pos.x)));
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        >
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgb(25_25_22/0.25)]"
            style={{ left: `${wipe * 100}%` }}
          />
          <div
            className="pointer-events-none absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-hairline bg-white text-[11px] font-semibold text-pine shadow-lift"
            style={{ left: `${wipe * 100}%` }}
          >
            ⇄
          </div>
          <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-2 rounded-full border border-hairline bg-white/90 px-2.5 py-1 text-[10.5px] font-medium tracking-[.04em] text-ink-soft shadow-[0_4px_12px_rgb(25_25_22/0.12)]">
            {wipe > 0.98 ? "Render" : wipe < 0.02 ? "Original" : "Drag to compare"}
          </div>

          {/* The exit. A compare view the user cannot leave is a trap — painting,
              labelling and aiming all happen on the PHOTO, so getting back to it
              must be one click, not a puzzle. */}
          {onBackToPhoto && (
            <button
              onClick={onBackToPhoto}
              className="absolute bottom-4 right-4 z-10 flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-white/95 px-3 text-[11px] font-semibold text-ink shadow-lift transition-colors hover:border-pine hover:text-pine"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m6 11 6-6 6 6" />
                <path d="M5 21h14" opacity="0" />
              </svg>
              Back to photo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
