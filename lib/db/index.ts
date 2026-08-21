/**
 * Postgres connection.
 *
 * The Pool is cached on globalThis because `next dev` re-evaluates modules on
 * every hot reload. Without the cache each save opens a fresh pool, the old one
 * is never closed, and Postgres starts refusing connections after a dozen edits.
 * The same module is imported by the standalone worker, where the cache is a
 * harmless no-op.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set (expected in frontend/.env.local)");
}

const globalForDb = globalThis as unknown as { __roomviPool?: Pool };

export const pool =
  globalForDb.__roomviPool ??
  new Pool({
    connectionString,
    // Two processes share this database (next dev + the worker); keep both
    // well clear of Postgres' default 100-connection ceiling.
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__roomviPool = pool;
}

export const db = drizzle(pool, { schema });

export * from "./schema";
