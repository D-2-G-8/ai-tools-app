/**
 * Одноразовая инициализация БД:
 * 1. включает расширение pgvector (Neon его поддерживает "из коробки", но
 *    расширение нужно явно включить один раз на базу);
 * 2. создаёт дефолтный workspace, если его ещё нет (однопользовательский режим).
 *
 * Запуск: pnpm db:setup
 */
import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../schema";

async function main() {
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("POSTGRES_URL (или DATABASE_URL) не задан в окружении/.env.local");
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log("Включаю расширение pgvector (если ещё не включено)...");
  await client`CREATE EXTENSION IF NOT EXISTS vector`;

  console.log("Проверяю дефолтный workspace...");
  const existing = await db.select().from(schema.workspace).limit(1);
  if (existing.length === 0) {
    const [ws] = await db
      .insert(schema.workspace)
      .values({ name: "Default workspace" })
      .returning();
    console.log(`Создан workspace: ${ws.id}`);
  } else {
    console.log(`Workspace уже существует: ${existing[0].id}`);
  }

  await client.end();
  console.log("Готово.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
