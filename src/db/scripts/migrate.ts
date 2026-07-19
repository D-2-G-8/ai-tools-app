/**
 * Automatic application of DB migrations.
 *
 * Runs as part of `pnpm build` (see package.json) — meaning that on every
 * deploy to Vercel (production and preview) migrations are applied
 * AUTOMATICALLY, no more need to reach for the terminal by hand.
 *
 * Safely idempotent:
 * - if POSTGRES_URL is not set (for example, a purely local build without a DB) —
 *   we just skip the step, the build doesn't fail;
 * - drizzle maintains its own __drizzle_migrations table and applies only the
 *   migrations from ./drizzle that haven't been applied yet — re-running
 *   doesn't break or duplicate anything.
 */
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../schema";

// dotenv/config by default reads only .env — it would silently ignore
// .env.local (the standard Next.js way to store local secrets).
// On Vercel the variables are already in process.env, so this affects only
// local runs and doesn't interfere with deployment in any way.
config({ path: [".env.local", ".env"] });

async function main() {
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.log("[db:migrate] POSTGRES_URL is not set — skipping migration.");
    return;
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    console.log("[db:migrate] Enabling the pgvector extension (if not already enabled)...");
    await client`CREATE EXTENSION IF NOT EXISTS vector`;

    console.log("[db:migrate] Applying migrations from ./drizzle...");
    await migrate(db, { migrationsFolder: "./drizzle" });

    console.log("[db:migrate] Checking the default workspace...");
    const existing = await db.select().from(schema.workspace).limit(1);
    if (existing.length === 0) {
      const [ws] = await db.insert(schema.workspace).values({ name: "Default workspace" }).returning();
      console.log(`[db:migrate] Created workspace: ${ws.id}`);
    }

    console.log("[db:migrate] Done.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[db:migrate] Migration failed:", err);
  process.exit(1);
});
