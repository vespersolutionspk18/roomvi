/**
 * Session seam.
 *
 * Phase 8 replaces the body of `resolveUser` with signed-cookie verification.
 * Everything else in the app reads the current user through this function, so
 * that swap touches one file. Deliberately NOT a stub that returns a fake id:
 * it creates a real row, so foreign keys, cascades and the credit ledger behave
 * exactly as they will with real auth.
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./db/schema";

const DEV_EMAIL = "dev@roomvi.local";

export type SessionUser = {
  id: string;
  email: string;
  credits: number;
};

export async function resolveUser(): Promise<SessionUser> {
  // Production refuses by default: silently serving every visitor one shared
  // account would be the worst kind of bug. An explicit ALLOW_DEV_SESSION=1
  // opts a deployment into the single-user dev session anyway — the honest way
  // to run a demo before Phase 8 auth exists, because someone decided it.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_SESSION !== "1") {
    throw new Error("resolveUser: no session implementation (Phase 8 pending)");
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email, DEV_EMAIL),
  });
  if (existing) {
    return { id: existing.id, email: existing.email, credits: existing.credits };
  }

  const [created] = await db
    .insert(users)
    .values({
      email: DEV_EMAIL,
      // Not a login path — there is no verify step yet, so no hash to match.
      passwordHash: "!dev-no-login",
      name: "Dev",
      credits: 500,
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return { id: created.id, email: created.email, credits: created.credits };
  }

  // Lost a race with a concurrent request; the row exists now.
  const row = await db.query.users.findFirst({ where: eq(users.email, DEV_EMAIL) });
  if (!row) throw new Error("resolveUser: could not resolve dev user");
  return { id: row.id, email: row.email, credits: row.credits };
}
