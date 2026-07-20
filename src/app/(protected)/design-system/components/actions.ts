"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designComponent } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { componentSourcePaths } from "@/lib/design-system-codegen/component";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";
import { commitFiles } from "@/lib/github/client";
import { finishCodeGenSession } from "../settings/codegen-actions";

export interface DeleteComponentResult {
  ok: boolean;
  error?: string;
  /** Set when this component's code also had to be removed from the design-system repo. */
  prUrl?: string;
}

/**
 * Deletes a design_component row (see delete-component-button.tsx).
 *
 * IMPORTANT: metadata sync (src/lib/figma/sync.ts) is upsert-only and never
 * deletes -- see that file's upsertComponent. If this component's Figma
 * node still exists in the currently-synced file, the NEXT full sync (or a
 * targeted "Resync this component" for it, though you obviously can't
 * click that once it's gone) will just recreate the platform row, since
 * sync has no memory of "a person deleted this on purpose" -- see the
 * "last synced" timestamp, which flags rows the most recent sync didn't
 * touch (orphaned -- won't come back) vs ones it just confirmed.
 *
 * If code has already been generated for this component (codeSyncStatus
 * === "committed" -- it's real code living in the design-system repo that
 * other services may already depend on), a plain DB delete isn't enough:
 * this also commits a removal of its file set (componentSourcePaths) to
 * the workspace's current code-sync branch and opens/updates the PR --
 * same human-in-the-loop merge as every other code-sync write (see
 * src/lib/github/client.ts's mergePullRequest doc comment). The DB row is
 * only deleted AFTER that commit succeeds, so a GitHub-side failure
 * leaves the platform row intact rather than silently going out of sync
 * with the repo.
 */
export async function deleteComponent(slug: string): Promise<DeleteComponentResult> {
  const workspaceId = await getCurrentWorkspaceId();
  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  if (!component) return { ok: true }; // already gone -- nothing to do

  if (component.codeSyncStatus === "committed") {
    try {
      const paths = componentSourcePaths(component.slug);
      const branchName = await getOrOpenSessionBranch(workspaceId);
      await commitFiles(branchName, `Remove ${paths.componentName}`, [
        { path: paths.tsxPath, content: null },
        { path: paths.cssPath, content: null },
        { path: paths.storiesPath, content: null },
        { path: paths.indexPath, content: null },
      ]);
      const { prUrl } = await finishCodeGenSession(branchName);

      await db.delete(designComponent).where(eq(designComponent.id, component.id));
      revalidatePath("/design-system/components");
      revalidatePath(`/design-system/components/${slug}`);
      revalidatePath("/design-system/settings");
      return { ok: true, prUrl };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  await db.delete(designComponent).where(eq(designComponent.id, component.id));
  revalidatePath("/design-system/components");
  revalidatePath(`/design-system/components/${slug}`);
  return { ok: true };
}
