import { db } from "./index";
import { workspace } from "./schema";

/**
 * Однопользовательский режим: в приложении всегда один workspace.
 * Функция идемпотентна — если workspace ещё не создан (например, забыли
 * прогнать `pnpm db:setup`), создаёт его на лету.
 */
let cachedWorkspaceId: string | null = null;

export async function getDefaultWorkspaceId(): Promise<string> {
  if (cachedWorkspaceId) return cachedWorkspaceId;

  const existing = await db.select().from(workspace).limit(1);
  if (existing.length > 0) {
    cachedWorkspaceId = existing[0].id;
    return cachedWorkspaceId;
  }

  const [created] = await db
    .insert(workspace)
    .values({ name: "Default workspace" })
    .returning();
  cachedWorkspaceId = created.id;
  return cachedWorkspaceId;
}
