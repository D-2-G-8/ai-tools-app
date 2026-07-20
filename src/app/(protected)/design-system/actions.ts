"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designToken } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";

/**
 * Deletes every design_token row for this workspace -- same rationale as
 * clearAllComponents (design-system/components/actions.ts): metadata sync
 * never prunes rows on its own, so this is the bulk escape hatch for when
 * cleaning up individually isn't worth it. Run "Resync tokens" or a full
 * sync afterwards to repopulate from the current Figma file.
 */
export async function clearAllTokens(): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  await db.delete(designToken).where(eq(designToken.workspaceId, workspaceId));
  revalidatePath("/design-system");
}
