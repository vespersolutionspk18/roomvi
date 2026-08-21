/**
 * Pricing — the showroom's pricing.html, ported. Static by design: the plans
 * are marketing copy, while the actual spend control lives in the credit ledger
 * the workspace header shows.
 */
import Link from "next/link";
import { AppHeader } from "@/components/site/AppHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { resolveUser } from "@/lib/session";

const PLANS = [
  {
    name: "Sketch",
    price: "Free",
    per: "forever",
    feat: false,
    cta: "Start free",
    href: "/new",
    lines: [
      ["3 rooms", ", 10 renders a month"],
      ["Core library", " of real trade materials"],
      ["Zone detection", " and share links"],
      ["Precision renders", " — always free, on every plan"],
    ],
  },
  {
    name: "Studio",
    price: "£29",
    per: "per month",
    feat: true,
    cta: "Start 14-day trial",
    href: "/new",
    lines: [
      ["Unlimited rooms", ", 60 renders a month"],
      ["Full library", " — 1,400+ SKUs"],
      ["PDF spec sheets", " and priority rendering"],
      ["3000 px exports", " for client presentations"],
    ],
  },
  {
    name: "Showroom",
    price: "Talk to us",
    per: "bespoke",
    feat: false,
    cta: "See what is included",
    href: "/materials",
    lines: [
      ["Everything in Studio", ", unlimited renders"],
      ["White-label client links", " under your name"],
      ["Trade pricing feed", " from 40+ suppliers"],
      ["Onboarding", " for the whole team"],
    ],
  },
];

const FAQ = [
  [
    "What exactly is a render?",
    "One generative edit of one photo — a model call, composited back through your surface masks. Precision renders (real tile laid at true scale) never count against your plan; they run on our machines with no model involved.",
  ],
  [
    "How accurate is true scale, really?",
    "As accurate as your tape measure. You place guides over a patch whose size you know and type that span; every course of tile is then laid in world millimetres. Each precision render ships with its measurement — courses counted versus arithmetic expected — so you can see when it checks out.",
  ],
  [
    "Do I need good photos?",
    "Phone photos are fine. The upload gate checks sharpness and exposure before anything runs, because a blown-out wall has no shading to transfer and no render can fix that.",
  ],
  [
    "Can I cancel anytime?",
    "Yes. Rooms, renders and spec sheets stay exportable even if you drop back to Sketch.",
  ],
];

export default async function PricingPage() {
  const user = await resolveUser();

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader credits={user.credits} />

      <main className="flex-1">
        {/* hero */}
        <section
          className="border-b border-hairline text-center"
          style={{
            background:
              "radial-gradient(55% 80% at 50% 0%, rgb(169 131 79 / 0.12), transparent 60%), var(--color-panel)",
          }}
        >
          <div className="mx-auto w-full max-w-3xl px-6 py-16">
            <h1 className="font-display text-[36px] font-[560] leading-[1.08] tracking-[-.02em] text-ink">
              Pay for opinions, not experiments
            </h1>
            <p className="mx-auto mt-4 max-w-[52ch] text-[14px] leading-relaxed text-ink-soft">
              Detection and precision rendering are free on every plan. You only ever
              spend credits on generative edits — the ones that need a model.
            </p>
          </div>
        </section>

        {/* plans */}
        <section className="mx-auto w-full max-w-6xl px-6 py-14">
          <div className="grid gap-5 md:grid-cols-3">
            {PLANS.map((p, i) => (
              <article
                key={p.name}
                className={`fade-up relative flex flex-col rounded-card p-6 ${
                  p.feat
                    ? "border border-pine bg-panel shadow-[0_0_0_1px_var(--color-pine),var(--shadow-lift)]"
                    : "border border-hairline bg-panel shadow-card"
                }`}
                style={{ animationDelay: `${0.06 * i}s` }}
              >
                {p.feat && (
                  <span className="absolute -top-3 left-5 flex h-6 items-center rounded-full bg-brass px-2.5 text-[10.5px] font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h2 className="font-display text-[20px] font-[560] text-ink">{p.name}</h2>
                <div className="mt-4 font-display text-[38px] font-[560] leading-none tracking-[-.01em] text-ink">
                  {p.price}
                </div>
                <div className="mb-5 mt-1.5 text-[12px] text-ink-faint">{p.per}</div>
                <ul className="mb-7 grid gap-2.5">
                  {p.lines.map(([bold, rest]) => (
                    <li key={bold} className="flex items-start gap-2.5 text-[13px] leading-snug text-ink-soft">
                      <span className="mt-[2px] grid h-[15px] w-[15px] flex-shrink-0 place-items-center rounded-full bg-pine-tint text-pine" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-2 w-2">
                          <path d="M4.5 12.5l5 5 10-11" />
                        </svg>
                      </span>
                      <span>
                        <b className="font-semibold text-ink">{bold}</b>
                        {rest}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={p.href}
                  className={`mt-auto flex h-10 items-center justify-center rounded-[9px] text-[12.5px] font-semibold transition-colors ${
                    p.feat
                      ? "bg-pine text-white hover:bg-pine-dark"
                      : "border border-hairline bg-white text-ink-soft hover:border-pine hover:text-pine"
                  }`}
                >
                  {p.cta}
                </Link>
              </article>
            ))}
          </div>

          {/* faq */}
          <div className="mx-auto mt-16 max-w-3xl">
            <h2 className="text-center font-display text-[24px] font-[560] tracking-[-.01em] text-ink">
              Asked before every invoice
            </h2>
            <div className="mt-8 grid gap-3">
              {FAQ.map(([q, a]) => (
                <details key={q} className="group rounded-card border border-hairline bg-panel px-5 py-4 shadow-card">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-[16px] font-[560] text-ink [&::-webkit-details-marker]:hidden">
                    {q}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-shrink-0 text-ink-faint transition-transform duration-150 group-open:rotate-45" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </summary>
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{a}</p>
                </details>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="mt-16 text-center">
            <p className="text-[13px] text-ink-soft">Still deciding? The first room is free either way.</p>
            <Link
              href="/new"
              className="mt-4 inline-flex h-11 items-center gap-2 rounded-[9px] bg-pine px-6 text-[13px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
            >
              Start visualising
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M5 12h13" />
                <path d="m13 7 5 5-5 5" />
              </svg>
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
