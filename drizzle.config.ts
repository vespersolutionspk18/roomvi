/**
 * drizzle-kit config. Only used by the CLI (`npm run db:generate` / `db:migrate`),
 * never imported by the app.
 *
 * drizzle-kit does not read `.env.local` (that's a Next convention), so load it
 * here with Node's built-in env-file loader rather than adding dotenv-cli.
 */
import { existsSync } from "node:fs";
import type { Config } from "drizzle-kit";

for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}

export default {
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
} satisfies Config;
