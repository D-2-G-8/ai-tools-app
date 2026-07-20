import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { workspace, designComponent } from "@/db/schema";
import { listBranchPaths, getDesignSystemBaseBranch, getPullRequestState } from "@/lib/github/client";
import { componentSourcePaths } from "./component";

/**
 * Keeps the "pending PR" banner honest: if the open-PR pointer refers to a PR
 * that's since been merged, closed, or deleted, clear it. Cheap (one API call),
 * so it can run on every settings load. Returns whether it cleared anything.
 */
export async function reconcilePendingPr(workspaceId: string): Promise<{ cleared: boolean }> {
  const [ws] = await db
    .select({ url: workspace.designSystemPendingPrUrl })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  const prUrl = ws?.url;
  if (!prUrl) return { cleared: false };

  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return { cleared: false };
  const state = await getPullRequestState(Number(match[1]));
  if (state === "open") return { cleared: false };

  await db
    .update(workspace)
    .set({ designSystemPendingPrUrl: null, designSystemPendingPrBranch: null })
    .where(eq(workspace.id, workspaceId));
  return { cleared: true };
}

/**
 * Reconciles the DB's code-sync claims against what's actually in the repo.
 *
 * `codeSyncStatus = "committed"` is a claim ("we committed this component"),
 * not a fact -- if the open PR's branch is deleted without merging (or files
 * are removed in the repo), those components aren't in the design-system repo
 * anymore, but the DB still says they are. That drift makes later operations
 * fail (e.g. "remove from repo" tries to delete files that don't exist -> a
 * GitHub 422). This checks each committed component against the live branches
 * (base + the open PR branch, if it still exists) and resets any whose files
 * are gone back to "never", and clears a dangling pending-PR pointer.
 */
export interface ReconcileResult {
  reset: number;
  pendingCleared: boolean;
}

export async function reconcileCodeSyncWithRepo(workspaceId: string): Promise<ReconcileResult> {
  // First make the pending-PR pointer honest (merged/closed/deleted -> cleared).
  const pending = await reconcilePendingPr(workspaceId);
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);

  // "In the repo" = present on base OR on the still-open PR branch.
  const livePaths = new Set<string>();
  const basePaths = await listBranchPaths(getDesignSystemBaseBranch());
  if (basePaths) for (const p of basePaths) livePaths.add(p);

  let pendingCleared = pending.cleared;
  if (ws?.designSystemPendingPrBranch) {
    const pendingPaths = await listBranchPaths(ws.designSystemPendingPrBranch);
    if (pendingPaths) {
      for (const p of pendingPaths) livePaths.add(p);
    } else {
      // Open-PR branch is gone (deleted without merging) -- its commits never
      // reached base, so anything "committed" only on it isn't in the repo.
      await db
        .update(workspace)
        .set({ designSystemPendingPrBranch: null, designSystemPendingPrUrl: null })
        .where(eq(workspace.id, workspaceId));
      pendingCleared = true;
    }
  }

  const committed = await db
    .select({ id: designComponent.id, slug: designComponent.slug, isIcon: designComponent.isIcon })
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.codeSyncStatus, "committed")));

  const stale = committed.filter((c) => !livePaths.has(componentSourcePaths(c.slug, c.isIcon).tsxPath));
  if (stale.length > 0) {
    await db
      .update(designComponent)
      .set({ codeSyncStatus: "never", lastCodeCommitSha: null, lastCodeSyncAt: null })
      .where(
        and(
          eq(designComponent.workspaceId, workspaceId),
          inArray(
            designComponent.id,
            stale.map((c) => c.id),
          ),
        ),
      );
  }

  return { reset: stale.length, pendingCleared };
}
