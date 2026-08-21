export const dynamic = "force-dynamic";

/**
 * Landing — the showroom's index.html, ported and wired to real data.
 *
 * The hero's compare slider is not a marketing asset: it shows the latest ready
 * render against its own original photo, straight from storage. When the workspace
 * is empty the section steps aside gracefully — a product that has rendered
 * nothing yet should not pretend otherwise.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { CompareSlider } from "@/components/site/CompareSlider";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { db } from "@/lib/db";
import { images, materials, renders } from "@/lib/db/schema";

export default async function Home() {
  const [hero] = await db
    .select({
      outputKey: renders.outputKey,
      displayKey: images.displayKey,
      renderId: renders.id,
    })
    .from(renders)
    .innerJoin(images, eq(renders.baseImageId, images.id))
    .where(and(eq(renders.status, "ready"), isNotNull(renders.outputKey), isNotNull(images.displayKey)))
    .orderBy(desc(renders.completedAt))
    .limit(1);

  const showcase = await db
    .select({
      id: materials.id,
      name: materials.name,
      category: materials.category,
      finish: materials.finish,
      size: materials.tileWMm,
      heroKey: materials.heroKey,
      precisionReady: materials.precisionReady,
    })
    .from(materials)
    .where(and(eq(materials.active, true), isNotNull(materials.heroKey)))
    .orderBy(desc(materials.precisionReady), materials.name)
    .limit(4);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* ------------------------------------------------------- hero */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-[1fr_1.15fr] lg:pt-24">
          <div className="fade-up flex flex-col items-start gap-6">
            <span className="inline-flex h-7 items-center gap-2 rounded-full border border-hairline bg-panel px-3 text-[11.5px] font-medium text-ink-soft shadow-card">
              <span className="h-[7px] w-[7px] rounded-full bg-pine" />
              Real materials, on your actual room
            </span>
            <h1 className="font-display text-[44px] font-[560] leading-[1.05] tracking-[-.02em] text-ink sm:text-[56px]">
              See it before you commit.
            </h1>
            <p className="max-w-[46ch] text-[15px] leading-relaxed text-ink-soft">
              Upload one photo of the room. roomvi detects its surfaces, then lays real
              flooring, tile and stone over them at true millimetre scale — so the
              argument about the kitchen ends before the order goes in.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/new"
                className="flex h-11 items-center gap-2 rounded-[9px] bg-pine px-5 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
              >
                Start visualising
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M5 12h13" />
                  <path d="m13 7 5 5-5 5" />
                </svg>
              </Link>
              <Link
                href="/materials"
                className="flex h-11 items-center rounded-[9px] border border-hairline bg-panel px-5 text-[13px] font-semibold text-ink transition-colors hover:border-pine hover:text-pine"
              >
                Browse materials
              </Link>
            </div>
            <p className="text-[12px] text-ink-faint">
              Precision renders are free — the measurement does the work, not a model.
            </p>
          </div>

          <div className="fade-up" style={{ animationDelay: ".08s" }}>
            {hero?.outputKey && hero.displayKey ? (
              <>
                <CompareSlider
                  beforeUrl={`/api/files/${hero.displayKey}`}
                  afterUrl={`/api/files/${hero.outputKey}`}
                  afterLabel="Rendered with roomvi"
                  className="aspect-[16/10.5]"
                />
                <p className="mt-3 flex items-center justify-end gap-1.5 text-[11.5px] text-ink-faint">
                  Drag the seam — an actual roomvi render, not a mockup.
                </p>
              </>
            ) : (
              <div className="grid aspect-[16/10.5] place-items-center rounded-card border border-dashed border-hairline bg-panel">
                <div className="max-w-xs text-center">
                  <div className="font-display text-[19px] font-[560] text-ink">Your first render lands here</div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
                    Upload a room photo and this space fills with your own before/after.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------- steps */}
        <section className="border-y border-hairline bg-panel">
          <div className="mx-auto w-full max-w-6xl px-6 py-16">
            <h2 className="font-display text-[26px] font-[560] tracking-[-.01em] text-ink">
              Three steps, one afternoon
            </h2>
            <div className="mt-9 grid gap-5 md:grid-cols-3">
              {[
                {
                  n: "1",
                  title: "Photograph the room",
                  body: "One photo, phone quality is fine. Our gate checks sharpness and exposure before anything costs you money.",
                },
                {
                  n: "2",
                  title: "We detect the surfaces",
                  body: "Floor, walls, ceiling, worktops, splashback, cabinets, windows — seven zones, found once and reused for everything you try.",
                },
                {
                  n: "3",
                  title: "Try materials at true scale",
                  body: "Real SKUs laid by the millimetre, with a measured verdict on every precision render. Compare, share, decide.",
                },
              ].map((s, i) => (
                <article
                  key={s.n}
                  className="fade-up flex flex-col gap-3 rounded-card border border-hairline bg-porcelain p-6"
                  style={{ animationDelay: `${0.06 * i}s` }}
                >
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-pine font-display text-[14px] font-[560] text-white">
                    {s.n}
                  </span>
                  <h3 className="font-display text-[18px] font-[560] text-ink">{s.title}</h3>
                  <p className="text-[13px] leading-relaxed text-ink-soft">{s.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- features */}
        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="mb-9 flex items-end justify-between gap-6">
            <div>
              <h2 className="font-display text-[26px] font-[560] tracking-[-.01em] text-ink">
                Built for the moment of doubt
              </h2>
              <p className="mt-2 max-w-[52ch] text-[13.5px] leading-relaxed text-ink-soft">
                Every feature answers the same question: will this actually look like
                this, in this light, at this size?
              </p>
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: "True scale, measured",
                body: "Place guides over a patch whose size you know; tiles land at their real trade dimensions, grout joints included.",
                icon: (
                  <>
                    <path d="M6.8 9.2 15 5.6l3 6.4-8.2 3.6z" />
                    <path d="M9.8 15.6l8-3.5 1.4 3-8 3.5z" opacity=".55" />
                    <circle cx="6.8" cy="9.2" r=".9" fill="currentColor" stroke="none" />
                    <circle cx="18" cy="12" r=".9" fill="currentColor" stroke="none" />
                  </>
                ),
              },
              {
                title: "Zones, found once",
                body: "Segmentation runs one paid pass per photo. Every material you try afterwards reuses those masks for free.",
                icon: (
                  <>
                    <rect x="4" y="5.5" width="7" height="13" rx="1.6" />
                    <rect x="13" y="5.5" width="7" height="7" rx="1.6" />
                    <rect x="13" y="14.5" width="7" height="4" rx="1.6" />
                  </>
                ),
              },
              {
                title: "Honest comparisons",
                body: "A before/after seam you can drag, plus a drift score when a generative edit wanders outside its lane.",
                icon: (
                  <>
                    <circle cx="10.5" cy="10.5" r="6.2" />
                    <path d="m15.2 15.2 4.8 4.8" />
                    <path d="M10.5 7.5v6M7.5 10.5h6" />
                  </>
                ),
              },
              {
                title: "Free where it can be",
                body: "Precision rendering happens on our machines with no model call: zero credits, repeatable as often as you like.",
                icon: (
                  <>
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M12 7.5V12l3 2" />
                  </>
                ),
              },
            ].map((f, i) => (
              <article
                key={f.title}
                className="fade-up flex flex-col gap-3 rounded-card border border-hairline bg-panel p-5 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift"
                style={{ animationDelay: `${0.05 * i}s` }}
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-pine-tint text-pine">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]" aria-hidden="true">
                    {f.icon}
                  </svg>
                </span>
                <h3 className="font-display text-[16.5px] font-[560] leading-snug text-ink">{f.title}</h3>
                <p className="text-[12.5px] leading-relaxed text-ink-soft">{f.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------- materials */}
        {showcase.length > 0 && (
          <section className="border-y border-hairline bg-panel">
            <div className="mx-auto w-full max-w-6xl px-6 py-16">
              <div className="mb-8 flex items-end justify-between gap-6">
                <div>
                  <h2 className="font-display text-[26px] font-[560] tracking-[-.01em] text-ink">
                    From the library
                  </h2>
                  <p className="mt-2 text-[13.5px] text-ink-soft">
                    Trade SKUs with real dimensions and seamless bitmaps — ready to lay.
                  </p>
                </div>
                <Link href="/materials" className="hidden shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-pine hover:text-pine-dark sm:flex">
                  Open the library
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                    <path d="M5 12h13" />
                    <path d="m13 7 5 5-5 5" />
                  </svg>
                </Link>
              </div>

              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {showcase.map((m, i) => (
                  <Link
                    key={m.id}
                    href="/materials"
                    className="fade-up group relative block aspect-[4/4.4] overflow-hidden rounded-card border border-hairline shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-lift"
                    style={{ animationDelay: `${0.05 * i}s` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files/${m.heroKey}`}
                      alt={m.name}
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      loading="lazy"
                    />
                    {m.precisionReady && (
                      <span className="absolute left-3 top-3 flex h-6 items-center gap-1.5 rounded-full bg-white/95 px-2 text-[10px] font-semibold text-pine shadow-card">
                        <span className="h-[6px] w-[6px] rounded-full bg-pine" />
                        True scale
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(20_20_16/0.72)] to-transparent px-3.5 pb-3 pt-10">
                      <div className="font-display text-[16px] font-[560] text-white">{m.name}</div>
                      <div className="text-[11px] capitalize text-white/70">
                        {m.category}
                        {m.finish ? ` · ${m.finish}` : ""}
                        {m.size ? ` · ${m.size}mm` : ""}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* ------------------------------------------------------ pricing teaser */}
        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="mb-8">
            <h2 className="font-display text-[26px] font-[560] tracking-[-.01em] text-ink">Plans</h2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              { name: "Sketch", price: "Free", per: "forever", feat: false, lines: ["3 rooms, 10 renders a month", "Core library", "Zone detection & share links"] },
              { name: "Studio", price: "£29", per: "per month", feat: true, lines: ["Unlimited rooms, 60 renders", "Full library — 1,400+ SKUs", "PDF spec sheets & priority queue"] },
              { name: "Showroom", price: "Talk to us", per: "bespoke", feat: false, lines: ["Unlimited renders", "White-label client links", "Trade pricing feed"] },
            ].map((p) => (
              <article
                key={p.name}
                className={`relative flex flex-col rounded-card p-6 ${
                  p.feat
                    ? "border border-pine bg-panel shadow-[0_0_0_1px_var(--color-pine),var(--shadow-lift)]"
                    : "border border-hairline bg-panel shadow-card"
                }`}
              >
                {p.feat && (
                  <span className="absolute -top-3 left-5 flex h-6 items-center rounded-full bg-brass px-2.5 text-[10.5px] font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="font-display text-[19px] font-[560] text-ink">{p.name}</h3>
                <div className="mt-3 font-display text-[34px] font-[560] leading-none text-ink">{p.price}</div>
                <div className="mb-4 mt-1 text-[12px] text-ink-faint">{p.per}</div>
                <ul className="mb-6 grid gap-2">
                  {p.lines.map((l) => (
                    <li key={l} className="flex items-start gap-2 text-[12.5px] leading-snug text-ink-soft">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] h-3.5 w-3.5 flex-shrink-0 text-pine" aria-hidden="true">
                        <path d="M4.5 12.5l5 5 10-11" />
                      </svg>
                      {l}
                    </li>
                  ))}
                </ul>
                <Link
                  href={p.feat || p.name === "Sketch" ? "/new" : "/pricing"}
                  className={`mt-auto flex h-10 items-center justify-center rounded-[9px] text-[12.5px] font-semibold transition-colors ${
                    p.feat
                      ? "bg-pine text-white hover:bg-pine-dark"
                      : "border border-hairline bg-white text-ink-soft hover:border-pine hover:text-pine"
                  }`}
                >
                  {p.name === "Showroom" ? "See details" : "Start free"}
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------- CTA band */}
        <section
          className="border-t border-hairline text-center"
          style={{
            background:
              "radial-gradient(60% 90% at 50% 0%, rgb(169 131 79 / 0.14), transparent 60%), var(--color-porcelain)",
          }}
        >
          <div className="mx-auto w-full max-w-3xl px-6 py-20">
            <h2 className="mx-auto max-w-[20ch] font-display text-[30px] font-[560] leading-[1.15] tracking-[-.015em] text-ink">
              Try it on the room you have been arguing about
            </h2>
            <p className="mx-auto mt-4 max-w-[48ch] text-[13.5px] leading-relaxed text-ink-soft">
              One photo is enough. Detection runs once, and every material afterwards is
              a click — most of them free.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/new"
                className="flex h-11 items-center gap-2 rounded-[9px] bg-pine px-6 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
              >
                Start free
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M5 12h13" />
                  <path d="m13 7 5 5-5 5" />
                </svg>
              </Link>
              <Link
                href="/pricing"
                className="flex h-11 items-center rounded-[9px] border border-hairline bg-panel px-6 text-[13px] font-semibold text-ink transition-colors hover:border-pine hover:text-pine"
              >
                Compare plans
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

