/**
 * Rooms — the workspace dashboard.
 *
 * Stats are computed from what is actually on disk (renders, ops) rather than a
 * counter table, because at this scale the queries are cheap and a second source
 * of truth would eventually disagree with the first.
 */
import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { AppHeader } from "@/components/site/AppHeader";
import { db } from "@/lib/db";
import { images, projects, renderOps, renders } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";

export default async function Dashboard() {
  const user = await resolveUser();

  const rooms = await db
    .select({
      id: images.id,
      projectId: images.projectId,
      projectName: projects.name,
      displayKey: images.displayKey,
      analyzedAt: images.analyzedAt,
      createdAt: images.createdAt,
    })
    .from(images)
    .innerJoin(projects, eq(images.projectId, projects.id))
    .where(eq(projects.userId, user.id))
    .orderBy(desc(images.createdAt))
    .limit(12);

  const ids = rooms.map((r) => r.id);

  // One round-trip each for renders and their ops, aggregated here — the volume
  // per workspace is small, and three nested loops beat four sequential queries
  // the ORM would issue anyway.
  const renderRows = ids.length
    ? await db
        .select({
          id: renders.id,
          baseImageId: renders.baseImageId,
          status: renders.status,
          executor: renders.executor,
          outputKey: renders.outputKey,
          createdAt: renders.createdAt,
        })
        .from(renders)
        .where(inArray(renders.baseImageId, ids))
    : [];

  const opRows = renderRows.length
    ? await db
        .select({ renderId: renderOps.renderId, kind: renderOps.kind, materialId: renderOps.materialId })
        .from(renderOps)
        .where(inArray(renderOps.renderId, renderRows.map((r) => r.id)))
    : [];

  type RoomStat = {
    renderCount: number;
    lastRenderAt: Date | null;
    latestReadyKey: string | null;
    materialsTried: Set<string>;
  };
  const byImage = new Map<string, RoomStat>();
  const statFor = (imageId: string): RoomStat => {
    let s = byImage.get(imageId);
    if (!s) {
      s = { renderCount: 0, lastRenderAt: null, latestReadyKey: null, materialsTried: new Set() };
      byImage.set(imageId, s);
    }
    return s;
  };

  const opRenderKind = new Map(opRows.map((o) => [o.renderId, o]));
  for (const r of renderRows) {
    const s = statFor(r.baseImageId);
    s.renderCount++;
    if (!s.lastRenderAt || r.createdAt > s.lastRenderAt) s.lastRenderAt = r.createdAt;
    if (r.status === "ready" && r.outputKey) s.latestReadyKey = r.outputKey;
    const op = opRenderKind.get(r.id);
    if (op?.kind === "material" && op.materialId) s.materialsTried.add(op.materialId);
  }

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rendersThisMonth = renderRows.filter((r) => r.createdAt >= monthStart).length;
  const freeRenders = renderRows.filter((r) => r.executor === "precision" && r.status === "ready").length;

  const stats = [
    { label: "Rooms", value: String(rooms.length), note: rooms.some((r) => !r.analyzedAt) ? "one awaiting detection" : "all detected" },
    { label: "Renders this month", value: String(rendersThisMonth), note: `${freeRenders} of them free` },
    {
      label: "Materials tried",
      value: String(new Set([...byImage.values()].flatMap((s) => [...s.materialsTried])).size),
      note: "across every room",
    },
    { label: "Credits left", value: String(user.credits), note: "precision never spends them" },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader credits={user.credits} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 pb-16 pt-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] font-[560] leading-[1.1] tracking-[-.015em] text-ink">
              Your rooms
            </h1>
            <p className="mt-2 text-[13px] text-ink-soft">
              Every photo you have brought in, and where each one got to.
            </p>
          </div>
          <Link
            href="/new"
            className="flex h-10 items-center gap-2 rounded-[9px] bg-pine px-4 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgb(39_76_62/0.28)] transition-all duration-150 hover:bg-pine-dark hover:-translate-y-px"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New room
          </Link>
        </div>

        {/* stats */}
        <div className="mb-9 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {stats.map((s, i) => (
            <div key={s.label} className="fade-up flex flex-col gap-1 rounded-card border border-hairline bg-panel p-4 shadow-card" style={{ animationDelay: `${0.05 * i}s` }}>
              <span className="text-[11.5px] font-medium text-ink-faint">{s.label}</span>
              <span className="font-display text-[28px] font-[560] leading-[1.1] text-ink tabular-nums">{s.value}</span>
              <span className="text-[11px] text-ink-faint">{s.note}</span>
            </div>
          ))}
        </div>

        {/* room cards */}
        {rooms.length === 0 ? (
          <div className="grid place-items-center rounded-card border border-dashed border-hairline bg-panel py-20">
            <div className="max-w-sm text-center">
              <div className="font-display text-[21px] font-[560] text-ink">No rooms yet</div>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                Bring in one photo of a room you are redecorating — detection takes about a minute.
              </p>
              <Link
                href="/new"
                className="mt-6 inline-flex h-10 items-center rounded-[9px] bg-pine px-5 text-[12.5px] font-semibold text-white hover:bg-pine-dark"
              >
                Upload a photo
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room, i) => {
              const s = statFor(room.id);
              const thumb = s.latestReadyKey ?? room.displayKey;
              return (
                <article
                  key={room.id}
                  className="fade-up overflow-hidden rounded-card border border-hairline bg-panel shadow-card transition-all duration-200 hover:-translate-y-1 hover:shadow-lift"
                  style={{ animationDelay: `${0.04 * i}s` }}
                >
                  <Link href={`/editor/${room.id}`} className="relative block aspect-[16/10] overflow-hidden border-b border-hairline bg-porcelain">
                    {thumb && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/files/${thumb}`} alt={room.projectName} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
                    )}
                    <span className="absolute bottom-3 right-3 flex h-7 items-center gap-1.5 rounded-full bg-white/95 px-2.5 text-[11px] font-semibold text-ink opacity-0 shadow-card transition-opacity duration-150 hover:opacity-100 group-hover:opacity-100 [article:hover_&]:opacity-100">
                      Open editor
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
                        <path d="M5 12h13" />
                        <path d="m13 7 5 5-5 5" />
                      </svg>
                    </span>
                  </Link>

                  <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
                    <div className="min-w-0">
                      <h3 className="truncate font-display text-[15.5px] font-[560] text-ink">{room.projectName}</h3>
                      <p className="mt-0.5 text-[11.5px] text-ink-soft">
                        {s.materialsTried.size} material{s.materialsTried.size === 1 ? "" : "s"} tried
                        {s.lastRenderAt ? ` · rendered ${timeAgo(s.lastRenderAt)}` : ""}
                      </p>
                    </div>
                    <span
                      className={`mt-0.5 inline-flex h-[22px] flex-shrink-0 items-center gap-1.5 rounded-full px-2 text-[10.5px] font-semibold ${
                        room.analyzedAt ? "bg-pine-tint text-pine" : "bg-brass-tint text-brass"
                      }`}
                    >
                      <span className={`h-[5px] w-[5px] rounded-full ${room.analyzedAt ? "bg-pine" : "bg-brass"}`} />
                      {room.analyzedAt ? "Ready" : "Undetected"}
                    </span>
                  </div>

                  <div className="flex items-center justify-between px-4 pb-3.5">
                    <span className="text-[11px] text-ink-faint">
                      {s.renderCount > 0 ? `${s.renderCount} render${s.renderCount === 1 ? "" : "s"}` : "no renders yet"}
                    </span>
                    <Link href={`/projects/${room.projectId}`} className="text-[11.5px] font-medium text-pine hover:text-pine-dark">
                      Project →
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

/** Coarse relative time — the dashboard never needs minute precision. */
function timeAgo(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
