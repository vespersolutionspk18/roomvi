export const dynamic = "force-dynamic";

/**
 * Project — one room's story: the compare, what is in it, and every render
 * version. Reads straight from the DB in the server component; the only client
 * pieces are the compare slider and the copy button.
 *
 * The versions grid is the anti-drift invariant made visible: every row is a
 * full render against the ORIGINAL photo (never chained), so any of them can be
 * reopened without fear of generation loss.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/site/AppHeader";
import { CompareSlider } from "@/components/site/CompareSlider";
import { CopyLink } from "@/components/site/CopyLink";
import { db } from "@/lib/db";
import { images, materials, projects, renderOps, renders, surfaces } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await resolveUser();

  // Scoped to the owner: another user's project id is a 404, not a leak.
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, id), eq(projects.userId, user.id)),
  });
  if (!project) notFound();

  const imgs = await db
    .select({
      id: images.id,
      displayKey: images.displayKey,
      analyzedAt: images.analyzedAt,
    })
    .from(images)
    .where(eq(images.projectId, id))
    .orderBy(desc(images.createdAt));

  const imgIds = imgs.map((i) => i.id);
  const imgById = new Map(imgs.map((i) => [i.id, i]));

  const renderRows = imgIds.length
    ? await db
        .select()
        .from(renders)
        .where(inArray(renders.baseImageId, imgIds))
        .orderBy(desc(renders.createdAt))
        .limit(24)
    : [];

  const opRows = renderRows.length
    ? await db
        .select({
          renderId: renderOps.renderId,
          kind: renderOps.kind,
          surfaceId: renderOps.surfaceId,
          materialId: renderOps.materialId,
          prompt: renderOps.prompt,
          materialName: materials.name,
          materialHero: materials.heroKey,
          materialCategory: materials.category,
          tileWMm: materials.tileWMm,
          tileHMm: materials.tileHMm,
          zoneLabel: surfaces.label,
        })
        .from(renderOps)
        .leftJoin(materials, eq(renderOps.materialId, materials.id))
        .leftJoin(surfaces, eq(renderOps.surfaceId, surfaces.id))
        .where(inArray(renderOps.renderId, renderRows.map((r) => r.id)))
    : [];

  const opsByRender = new Map<string, typeof opRows>();
  for (const op of opRows) {
    const list = opsByRender.get(op.renderId) ?? [];
    list.push(op);
    opsByRender.set(op.renderId, list);
  }

  const ready = renderRows.filter((r) => r.status === "ready" && r.outputKey);
  const latest = ready[0] ?? null;
  const beforeKey = latest ? imgById.get(latest.baseImageId)?.displayKey ?? null : null;

  const applied = latest
    ? (opsByRender.get(latest.id) ?? []).filter((o) => o.kind === "material" && o.materialName)
    : [];

  const analyzedCount = imgs.filter((i) => i.analyzedAt).length;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader credits={user.credits} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16 pt-8">
        {/* crumb */}
        <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-[12px] text-ink-faint">
          <Link href="/dashboard" className="transition-colors hover:text-pine">
            Rooms
          </Link>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 opacity-60" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
          <span className="text-ink-soft">{project.name}</span>
        </nav>

        {/* head */}
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] font-[560] leading-[1.1] tracking-[-.015em] text-ink">
              {project.name}
            </h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Chip tone={analyzedCount > 0 ? "pine" : "brass"}>
                <span className={`h-[5px] w-[5px] rounded-full ${analyzedCount > 0 ? "bg-pine" : "bg-brass"}`} />
                {analyzedCount > 0 ? `${analyzedCount} room${analyzedCount === 1 ? "" : "s"} detected` : "Not detected yet"}
              </Chip>
              <Chip>
                {ready.length} render{ready.length === 1 ? "" : "s"}
                {applied.length > 0 ? ` · ${applied.length} material${applied.length === 1 ? "" : "s"} applied` : ""}
              </Chip>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <CopyLink url={`/projects/${project.id}`} label="Share" />
            {imgs[0] && (
              <Link
                href={`/editor/${imgs[0].id}`}
                className="flex h-9 items-center gap-2 rounded-[9px] bg-pine px-4 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
              >
                Open editor
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M5 12h13" />
                  <path d="m13 7 5 5-5 5" />
                </svg>
              </Link>
            )}
          </div>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0">
            {/* compare */}
            {latest && beforeKey ? (
              <>
                <CompareSlider
                  beforeUrl={`/api/files/${beforeKey}`}
                  afterUrl={`/api/files/${latest.outputKey!}`}
                  afterLabel={describeRender(opsByRender.get(latest.id) ?? [])}
                  className="fade-up"
                />
                <p className="mt-3 text-[11.5px] text-ink-faint">
                  Drag the seam to compare the original photo with the latest render.
                </p>
              </>
            ) : (
              <div className="grid place-items-center rounded-card border border-dashed border-hairline bg-panel py-20 text-center">
                <div className="max-w-sm">
                  <div className="font-display text-[21px] font-[560] text-ink">No renders yet</div>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                    Open a photo in the editor, pick a surface, and apply your first
                    material — precision renders cost nothing.
                  </p>
                  {imgs[0] && (
                    <Link
                      href={`/editor/${imgs[0].id}`}
                      className="mt-6 inline-flex h-10 items-center rounded-[9px] bg-pine px-5 text-[12.5px] font-semibold text-white hover:bg-pine-dark"
                    >
                      Open the editor
                    </Link>
                  )}
                </div>
              </div>
            )}

            {/* materials applied */}
            {applied.length > 0 && (
              <section className="fade-up mt-9" style={{ animationDelay: ".06s" }}>
                <div className="mb-3.5 flex items-end justify-between gap-4">
                  <h2 className="font-display text-[21px] font-[560] tracking-[-.01em] text-ink">
                    What is in this room
                  </h2>
                  <span className="text-[11.5px] text-ink-faint">from the latest render</span>
                </div>
                <div className="grid gap-2.5">
                  {applied.map((op) => (
                    <article
                      key={op.renderId + String(op.materialId)}
                      className="flex items-center gap-3.5 rounded-card border border-hairline bg-panel p-3 shadow-card transition-colors hover:border-[#cfc9bc]"
                    >
                      <span className="h-[46px] w-[46px] flex-shrink-0 overflow-hidden rounded-[10px] border border-hairline bg-porcelain">
                        {op.materialHero && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/files/${op.materialHero}`} alt="" className="h-full w-full object-cover" loading="lazy" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate font-display text-[14.5px] font-[560] text-ink">{op.materialName}</h3>
                        <p className="mt-0.5 truncate text-[11.5px] capitalize text-ink-soft">
                          {op.materialCategory}
                          {op.tileWMm != null && op.tileHMm != null ? ` · ${op.tileWMm} × ${op.tileHMm}` : ""}
                        </p>
                      </div>
                      {op.zoneLabel && (
                        <span className="ml-auto inline-flex h-6 flex-shrink-0 items-center gap-1.5 rounded-full bg-pine-tint px-2.5 text-[10.5px] font-semibold capitalize text-pine">
                          <span className="h-[5px] w-[5px] rounded-full bg-brass" />
                          {op.zoneLabel}
                        </span>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            {/* versions */}
            {renderRows.length > 0 && (
              <section className="fade-up mt-9" style={{ animationDelay: ".1s" }}>
                <div className="mb-3.5 flex items-end justify-between gap-4">
                  <h2 className="font-display text-[21px] font-[560] tracking-[-.01em] text-ink">
                    Render versions
                  </h2>
                  <span className="text-[11.5px] text-ink-faint">{renderRows.length} kept</span>
                </div>
                <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                  {renderRows.slice(0, 9).map((r) => {
                    const ops = opsByRender.get(r.id) ?? [];
                    const thumb = r.outputKey ?? imgById.get(r.baseImageId)?.displayKey ?? null;
                    const isLatest = latest?.id === r.id;
                    return (
                      <article
                        key={r.id}
                        className={`overflow-hidden rounded-card border bg-panel shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift ${
                          isLatest ? "border-pine shadow-[0_0_0_1px_var(--color-pine)]" : "border-hairline"
                        }`}
                      >
                        <a href={r.outputKey ? `/api/files/${r.outputKey}` : undefined} target="_blank" rel="noreferrer" className="relative block aspect-[16/9] overflow-hidden border-b border-hairline bg-porcelain">
                          {thumb && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/api/files/${thumb}`} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                          )}
                          {!r.outputKey && (
                            <span className="absolute inset-0 grid place-items-center bg-porcelain/80 text-[11.5px] font-medium text-ink-faint">
                              {r.status === "failed" ? "Failed" : r.status}
                            </span>
                          )}
                          <span className="absolute bottom-2 left-2 flex h-[22px] items-center gap-1.5 rounded-full bg-white/95 px-2 text-[10px] font-semibold text-ink shadow-card">
                            {isLatest && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-pine)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5" aria-hidden="true">
                                <path d="M4.5 12.5l5 5 10-11" />
                              </svg>
                            )}
                            {isLatest ? "Current" : r.executor === "precision" ? "True scale" : "Generative"}
                          </span>
                        </a>
                        <div className="flex items-start justify-between gap-2 px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="truncate text-[12px] font-semibold text-ink">{describeRender(ops)}</div>
                            <div className="mt-0.5 text-[10.5px] text-ink-faint">{formatWhen(r.createdAt)}</div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* aside */}
          <aside className="grid gap-4 lg:sticky lg:top-[74px]">
            <section className="rounded-card border border-hairline bg-panel p-5 shadow-card">
              <h2 className="font-display text-[17px] font-[560] text-ink">Share this room</h2>
              <p className="mb-4 mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
                Anyone with the link sees the before/after and the material spec.
              </p>
              <div className="mb-3 flex h-10 items-center gap-2 overflow-hidden rounded-lg border border-hairline bg-[#FBFAF7] px-3">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0 text-ink-faint" aria-hidden="true">
                  <path d="M9.5 14.2a4 4 0 0 1 0-5.6l2.3-2.3a4 4 0 0 1 5.6 5.6l-1.2 1.2" />
                  <path d="M14.5 9.8a4 4 0 0 1 0 5.6l-2.3 2.3a4 4 0 0 1-5.6-5.6l1.2-1.2" />
                </svg>
                <span className="truncate text-[12px] text-ink-soft">roomvi.app/projects/{project.id}</span>
              </div>
              <CopyLink url={`/projects/${project.id}`} label="Copy link" />
            </section>

            <section className="rounded-card border border-hairline bg-panel p-5 shadow-card">
              <h2 className="mb-3 text-[13px] font-semibold text-ink">Every render includes</h2>
              <ul className="grid gap-2">
                {[
                  "True scale on measured surfaces",
                  "Lighting carried from your photo",
                  "Full-resolution export from storage",
                  "A version history that never chains edits",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-[12px] leading-snug text-ink-soft">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] h-3 w-3 flex-shrink-0 text-pine" aria-hidden="true">
                      <path d="M4.5 12.5l5 5 10-11" />
                    </svg>
                    {line}
                  </li>
                ))}
              </ul>
            </section>

            <section
              className="relative overflow-hidden rounded-card p-5 text-white"
              style={{ background: "linear-gradient(160deg, var(--color-pine) 0%, var(--color-pine-dark) 100%)" }}
            >
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: "radial-gradient(70% 60% at 90% 0%, rgb(169 131 79 / 0.30), transparent 60%)" }}
                aria-hidden="true"
              />
              <div className="relative">
                <h2 className="font-display text-[17px] font-[560]">Next room?</h2>
                <p className="mb-4 mt-1.5 text-[12.5px] leading-relaxed text-white/75">
                  Bathrooms, hallways, the bedroom you keep repainting in your head — all
                  fair game.
                </p>
                <Link
                  href="/new"
                  className="flex h-10 items-center justify-center gap-2 rounded-[9px] bg-white px-4 text-[12.5px] font-semibold text-pine transition-transform duration-150 hover:-translate-y-px"
                >
                  Upload a photo
                </Link>
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}

function Chip({ tone = "plain", children }: { tone?: "plain" | "pine" | "brass"; children: React.ReactNode }) {
  const tones = {
    plain: "border-hairline bg-panel text-ink-soft",
    pine: "bg-pine-tint text-pine",
    brass: "bg-brass-tint text-brass",
  } as const;
  return (
    <span className={`inline-flex h-[24px] items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** One line about what a render did, from its ops. */
function describeRender(
  ops: Array<{ kind: string; materialName: string | null; prompt: string | null; zoneLabel: string | null }>,
): string {
  const materialOp = ops.find((o) => o.kind === "material" && o.materialName);
  if (materialOp) {
    return materialOp.zoneLabel ? `${materialOp.materialName} · ${materialOp.zoneLabel}` : materialOp.materialName!;
  }
  const promptOp = ops.find((o) => o.kind === "prompt" && o.prompt);
  return promptOp?.prompt ?? "Edit";
}

function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
