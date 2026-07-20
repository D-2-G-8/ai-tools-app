"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designComponent } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";

/**
 * Deletes a design_component row (see delete-component-button.tsx).
 *
 * IMPORTANT: metadata sync (src/lib/figma/sync.ts) is upsert-only and never
 * deletes -- see that file's upsertComponent. If this component's Figma
 * node still exists in the currently-synced file, the NEXT full sync (or a
 * targeted "Resync this component" for it, though you obviously can't
 * click that once it's gone) will just recreate the row, since sync has no
 * memory of "a person deleted this on purpose". This only permanently
 * removes rows that are no longer found by sync -- see the "last synced"
 * timestamp on the components list, which flags rows the most recent full
 * sync didn't touch (orphaned -- won't come back) vs ones it just
 * confirmed (still live in Figma -- deleting it here is temporary; the
 * real fix is cleaning it up in Figma itself).
 */
export async function deleteComponent(slug: string): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  await db
    .delete(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)));

  revalidatePath("/design-system/components");
  revalidatePath(`/design-system/components/${slug}`);
}

/**
 * Deletes every design_component row for this workspace -- for when
 * duplicates/stale rows have piled up enough that sorting out
 * individually what's garbage (see deleteComponent above) isn't worth it.
 * Run a full sync afterwards to repopulate whatever's actually still in
 * the current Figma file.
 */
export async function clearAllComponents(): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  await db.delete(designComponent).where(eq(designComponent.workspaceId, workspaceId));
  revalidatePath("/design-system/components");
}
