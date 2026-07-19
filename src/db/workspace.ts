import { db } from "./index";
import { workspace } from "./schema";

/**
 * Single-user mode: the app always has exactly one workspace.
 * The function is idempotent — if the workspace hasn't been created yet
 * (for example, `pnpm db:setup` was forgotten), it creates it on the fly.
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
