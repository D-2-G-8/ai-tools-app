import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// drizzle-kit is a standalone CLI (unlike Next.js it doesn't auto-load
// .env.local), so load it explicitly with .env as a fallback.
config({ path: [".env.local", ".env"] });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "",
  },
  verbose: true,
  strict: true,
});
