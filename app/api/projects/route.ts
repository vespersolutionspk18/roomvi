/**
 * Projects: create and list.
 *
 * Auth lands in Phase 8. Until then a single dev user is resolved here so the
 * upload -> analyze -> render path can be exercised. `resolveUser` is the one
 * seam that changes when sessions arrive — every route below reads the user
 * through it rather than assuming.
 */
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { resolveUser } from "@/lib/session";

const CreateProject = z.object({
  name: z.string().trim().min(1).max(200),
});

export async function GET() {
  const user = await resolveUser();
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.updatedAt));
  return Response.json({ projects: rows });
}

export async function POST(request: Request) {
  const user = await resolveUser();

  const parsed = CreateProject.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { code: "invalid", message: "A project name is required." } },
      { status: 400 },
    );
  }

  const [row] = await db
    .insert(projects)
    .values({ userId: user.id, name: parsed.data.name })
    .returning();

  return Response.json({ project: row }, { status: 201 });
}
