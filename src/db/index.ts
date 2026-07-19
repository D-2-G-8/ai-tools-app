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
      "POSTGRES_URL (или DATABASE_URL) не задан. Подключи Neon Postgres в Vercel (Storage -> Marketplace -> Neon) " +
        "и добавь переменную окружения, либо создай .env.local для локальной разработки.",
    );
  }
  return url;
}

function createDb(): DB {
  const client = postgres(getConnectionString(), { max: 5 });
  return drizzle(client, { schema });
}

/**
 * Ленивая инициализация с кэшем: клиент Postgres создаётся только при первом
 * реальном обращении к БД (внутри запроса/server action), а не при импорте
 * модуля — иначе `next build` падает при сборке страниц в окружении без
 * настроенного POSTGRES_URL (например, до первого деплоя на Vercel). Кэш через
 * globalThis переживает hot-reload в dev и не пересоздаёт пул соединений на
 * каждое обращение.
 */
function getDb(): DB {
  if (!global.__dbInstance) {
    global.__dbInstance = createDb();
  }
  return global.__dbInstance;
}

export const db: DB = new Proxy({} as DB, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});
