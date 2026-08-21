"use client";

/**
 * The library browser — the showroom's materials.html grid, wired to the real
 * catalogue. Filtering is client-side on purpose: the whole active catalogue is
 * a few dozen rows with thumbnails already loaded, and a round-trip per keystroke
 * would make the shelf feel like a database.
 */
import { useMemo, useState } from "react";

export type CatalogueItem = {
  id: string;
  name: string;
  category: string;
  finish: string | null;
  tileWMm: number | null;
  tileHMm: number | null;
  leadTimeDays: number | null;
  heroKey: string | null;
  precisionReady: boolean;
  supplier: string | null;
};

const CATEGORY_LABELS: Record<string, string> = {
  flooring: "Flooring",
  tile: "Tile",
  stone: "Stone",
  wood: "Wood",
  rug: "Rugs",
  countertop: "Countertops",
  wallpaper: "Wallpaper",
  paint: "Paint",
  cabinetry: "Cabinetry",
};

export function MaterialBrowser({ items }: { items: CatalogueItem[] }) {
  const [category, setCategory] = useState<string | null>(null);
  const [finish, setFinish] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "size">("name");

  const categories = useMemo(() => [...new Set(items.map((m) => m.category))], [items]);
  const finishes = useMemo(
    () => ["all", ...new Set(items.map((m) => m.finish).filter((f): f is string => Boolean(f)))],
    [items],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((m) => {
        if (category && m.category !== category) return false;
        if (finish !== "all" && m.finish !== finish) return false;
        if (q && ![m.name, m.supplier ?? "", m.finish ?? ""].some((s) => s.toLowerCase().includes(q))) {
          return false;
        }
        return true;
      })
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : (b.tileWMm ?? 0) * (b.tileHMm ?? 0) - (a.tileWMm ?? 0) * (a.tileHMm ?? 0),
      );
  }, [items, category, finish, query, sort]);

  return (
    <>
      {/* category tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter by category">
        <TabButton active={category === null} onClick={() => setCategory(null)}>
          All <span className="text-ink-faint">{items.length}</span>
        </TabButton>
        {categories.map((c) => (
          <TabButton key={c} active={category === c} onClick={() => setCategory(c)}>
            {CATEGORY_LABELS[c] ?? c}{" "}
            <span className="text-ink-faint">{items.filter((m) => m.category === c).length}</span>
          </TabButton>
        ))}
      </div>

      {/* toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <label className="flex h-[38px] flex-1 items-center gap-2 rounded-card border border-hairline bg-panel px-3 focus-within:border-pine focus-within:shadow-[0_0_0_3px_var(--color-pine-tint)] sm:max-w-xs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-[15px] w-[15px] text-ink-faint" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m15.8 15.8 4.2 4.2" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the library…"
            aria-label="Search materials"
            className="w-full border-none bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-faint"
          />
        </label>

        <select
          value={finish}
          onChange={(e) => setFinish(e.target.value)}
          aria-label="Filter by finish"
          className="h-[38px] rounded-card border border-hairline bg-panel px-3 text-[12.5px] text-ink outline-none transition-colors hover:border-pine focus:border-pine"
        >
          {finishes.map((f) => (
            <option key={f} value={f}>
              {f === "all" ? "All finishes" : f}
            </option>
          ))}
        </select>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as "name" | "size")}
          aria-label="Sort materials"
          className="h-[38px] rounded-card border border-hairline bg-panel px-3 text-[12.5px] text-ink outline-none transition-colors hover:border-pine focus:border-pine"
        >
          <option value="name">Name A–Z</option>
          <option value="size">Largest format</option>
        </select>
      </div>

      <p className="mb-3.5 text-[12px] text-ink-faint">
        Showing <b className="font-semibold text-brass">{shown.length}</b> of {items.length} materials
      </p>

      {/* grid */}
      {shown.length === 0 ? (
        <div className="grid place-items-center rounded-card border border-dashed border-hairline bg-panel py-16 text-center">
          <div>
            <div className="font-display text-[19px] font-[560] text-ink">Nothing in the case matches that</div>
            <p className="mt-1.5 text-[12.5px] text-ink-soft">Try a broader search or clear the filters.</p>
            <button
              onClick={() => {
                setQuery("");
                setFinish("all");
                setCategory(null);
              }}
              className="mt-5 h-9 rounded-[9px] border border-hairline bg-white px-4 text-[12px] font-semibold text-ink-soft transition-colors hover:border-pine hover:text-pine"
            >
              Reset filters
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((m, i) => (
            <article
              key={m.id}
              className="fade-up overflow-hidden rounded-card border border-hairline bg-panel shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-lift"
              style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}
            >
              <div className="relative aspect-[4/3] overflow-hidden border-b border-hairline bg-porcelain">
                {m.heroKey ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/files/${m.heroKey}`} alt={m.name} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="absolute inset-0 bg-hairline" />
                )}
                {m.precisionReady && (
                  <span className="absolute left-2.5 top-2.5 flex h-6 items-center gap-1.5 rounded-full bg-white/95 px-2 text-[10px] font-semibold text-pine shadow-card">
                    <span className="h-[6px] w-[6px] rounded-full bg-pine" />
                    True scale
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2 p-4">
                <div>
                  <h3 className="font-display text-[16px] font-[560] leading-snug text-ink">{m.name}</h3>
                  <p className="mt-0.5 text-[11.5px] capitalize text-ink-soft">
                    {m.supplier ?? "House range"} · {CATEGORY_LABELS[m.category] ?? m.category}
                  </p>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {m.finish && <Chip>{m.finish}</Chip>}
                  {m.tileWMm != null && m.tileHMm != null && (
                    <Chip>
                      {m.tileWMm} × {m.tileHMm}
                    </Chip>
                  )}
                  {m.leadTimeDays != null && m.leadTimeDays > 7 && <Chip>{m.leadTimeDays}-day lead</Chip>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-[34px] items-center gap-1.5 rounded-[9px] border px-3 text-[12px] font-medium transition-all duration-150 ${
        active
          ? "border-pine bg-pine text-white shadow-[0_4px_12px_rgb(39_76_62/0.22)]"
          : "border-hairline bg-panel text-ink-soft hover:-translate-y-px hover:border-pine hover:text-pine"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-full bg-porcelain px-2 text-[10.5px] font-medium capitalize text-ink-soft">
      {children}
    </span>
  );
}
