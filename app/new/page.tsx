export const dynamic = "force-dynamic";

/**
 * New room — the upload flow, moved off the landing so the marketing page can
 * breathe. Carries the recent-rooms strip: analyze costs real money per photo,
 * so a bare dropzone invites re-uploading a photo whose seven masks are already
 * paid for and sitting on disk.
 */
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { AppHeader } from "@/components/site/AppHeader";
import { Uploader } from "@/components/Uploader";
import { db } from "@/lib/db";
import { images, projects } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";

export default async function NewRoom() {
  const user = await resolveUser();

  const recent = await db
    .select({
      id: images.id,
      displayKey: images.displayKey,
      analyzedAt: images.analyzedAt,
      projectName: projects.name,
    })
    .from(images)
    .innerJoin(projects, eq(images.projectId, projects.id))
    .where(eq(projects.userId, user.id))
    .orderBy(desc(images.createdAt))
    .limit(8);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader credits={user.credits} />

      <main className="flex-1">
        <Uploader />

        {recent.length > 0 && (
          <section className="mx-auto w-full max-w-5xl px-6 pb-16">
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-ink-faint">Your rooms</span>
              <Link href="/dashboard" className="text-[11.5px] font-medium text-pine hover:text-pine-dark">
                Open workspace
              </Link>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {recent.map((r) => (
                <Link
                  key={r.id}
                  href={`/editor/${r.id}`}
                  className="group relative aspect-[4/3] overflow-hidden rounded-card border border-hairline bg-panel shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift"
                >
                  {r.displayKey && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/files/${r.displayKey}`}
                      alt={r.projectName}
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(20_20_16/0.75)] to-transparent px-2.5 pb-2 pt-6">
                    <div className="truncate text-[11.5px] font-semibold text-white">{r.projectName}</div>
                    <div className="text-[10px] text-white/70">
                      {r.analyzedAt ? "zones ready" : "not detected yet"}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

