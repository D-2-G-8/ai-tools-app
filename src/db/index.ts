import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DB = PostgresJsDatabase<typeof schema>;

declare global {
  var __dbInstance: DB | undefined;
}

function getConnectionString() {
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "POSTGRES_URL (or DATABASE_URL) is not set. Connect Neon Postgres in Vercel (Storage -> Marketplace -> Neon) " +
        "and add the environment variable, or create .env.local for local development.",
    );
  }
  return url;
}

function createDb(): DB {
  const client = postgres(getConnectionString(), { max: 5 });
  return drizzle(client, { schema });
}

/**
 * Lazy initialization with caching: the Postgres client is created only on the
 * first real DB access (inside a request/server action), not at module import —
 * otherwise `next build` fails while building pages in an environment without a
 * configured POSTGRES_URL (for example, before the first deploy to Vercel). The
 * cache via globalThis survives hot-reload in dev and doesn't recreate the
 * connection pool on every access.
 */
function getDb(): DB {
  if (!global.__dbInstance) {
    global.__dbInstance = createDb();
  }
  return global.__dbInstance;
}

/**
 * The proxy's own target is a bare `{}`, not a real `PostgresJsDatabase` --
 * so besides `get`, we also need `getPrototypeOf` (and `has`, for
 * completeness) to forward to the real, lazily-created instance. Without
 * this, code that duck-types the object instead of just reading properties
 * off it breaks. Concretely: @auth/drizzle-adapter's `DrizzleAdapter(db,
 * ...)` calls drizzle-orm's `is(db, PgDatabase)`, which starts with
 * `db instanceof PgDatabase` -- and `instanceof` walks the prototype chain
 * via `[[GetPrototypeOf]]`, which on a plain `get`-only proxy resolves to
 * `Object.prototype` (the empty target's prototype), not the real
 * `PgDatabase` prototype, making every such check silently fail.
 */
export const db: DB = new Proxy({} as DB, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(getDb() as object, prop);
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getDb() as object);
  },
});
