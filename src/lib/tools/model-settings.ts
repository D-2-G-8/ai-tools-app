import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { toolSettings } from "@/db/schema";
import { getCurrentUser } from "@/db/users";
import { DEFAULT_MODEL_ID } from "@/lib/models";

/**
 * Resolves the model a tool run should use for the signed-in user: their
 * own per-tool setting (`toolSettings` row with `userId` = them) if they've
 * picked one on the Settings page, falling back to the legacy company-wide
 * row (userId IS NULL -- see schema.ts's comment on toolSettings.userId,
 * these predate per-user settings) if neither exists yet, and finally
 * DEFAULT_MODEL_ID if there's no setting at all.
 */
export async function getEffectiveModel(workspaceId: string, toolKey: string): Promise<string> {
  const currentUser = await getCurrentUser();

  const rows = await db
    .select()
    .from(toolSettings)
    .where(
      and(
        eq(toolSettings.workspaceId, workspaceId),
        eq(toolSettings.toolKey, toolKey),
        currentUser
          ? or(eq(toolSettings.userId, currentUser.id), isNull(toolSettings.userId))
          : isNull(toolSettings.userId),
      ),
    );

  const personal = currentUser ? rows.find((r) => r.userId === currentUser.id) : undefined;
  const legacyDefault = rows.find((r) => r.userId === null);

  return personal?.model ?? legacyDefault?.model ?? DEFAULT_MODEL_ID;
}
