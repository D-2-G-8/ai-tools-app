"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designComponent, designToken, workspace, type DesignTokenCategory } from "@/db/schema";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { componentSourcePaths } from "@/lib/design-system-codegen/component";
import { generateTokensCss } from "@/lib/design-system-codegen/tokens";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";
import { reconcileCodeSyncWithRepo } from "@/lib/design-system-codegen/reconcile";
import { commitFiles, listBranchPaths, getDesignSystemBaseBranch, type CommitFile } from "@/lib/github/client";
import { finishCodeGenSession } from "./codegen-actions";

const SETTINGS_PATH = "/design-system/settings";

/**
 * The branch a "remove from repo" cleanup should commit its deletions to --
 * WITHOUT ever minting a fresh branch as a surprising side effect of a cleanup
 * click. Reuses the currently-open PR branch if it still exists; otherwise
 * opens a session branch ONLY when the files are genuinely still on the base
 * branch (they were merged, so removing them really does need a PR). Returns
 * null when there's nothing in the repo to change -- the caller then does a
 * DB-only cleanup, so clicking "delete" right after you deleted your branch/PR
 * can't resurrect a phantom `figma-sync-<ts>` branch. `filesOnBase` is asked
 * only when needed (no open PR) to keep the common path to a single API call.
 */
async function branchForRepoCleanup(
  workspaceId: string,
  filesOnBase: (basePaths: Set<string>) => boolean,
): Promise<string | null> {
  const [ws] = await db
    .select({ branch: workspace.designSystemPendingPrBranch })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  if (ws?.branch) {
    const exists = await listBranchPaths(ws.branch);
    if (exists) return ws.branch; // reuse the open PR branch; never open a new one
  }
  const basePaths = await listBranchPaths(getDesignSystemBaseBranch());
  if (basePaths && filesOnBase(basePaths)) return getOrOpenSessionBranch(workspaceId);
  return null; // nothing in the repo -> DB-only cleanup, no branch minted
}

/**
 * Bulk cleanup for stale/duplicate Figma-synced data (see design-system/
 * components/actions.ts's deleteComponent doc comment for the single-item
 * version of this same distinction). Split into four actions rather than
 * one "clear everything" button because the two kinds of row need
 * genuinely different handling:
 *
 * - Metadata only (never generated into code): a plain DB delete. Cheap,
 *   instant, no GitHub calls -- for the common case of a Figma file with
 *   duplicate/renamed/stale components or tokens that were only ever
 *   synced, never turned into real code.
 * - Already committed to the design-system repo: other UI services may
 *   already depend on that code, so clearing it also has to remove it
 *   from the repo (one commit removing every affected component's file
 *   set / regenerating tokens.css without the removed tokens), open/
 *   update the PR, and only then delete the DB rows -- same human-in-the-
 *   loop merge as every other code-sync write.
 */

export async function clearUnsyncedComponents(): Promise<{ deleted: number }> {
  const workspaceId = await getCurrentWorkspaceId();
  const deleted = await db
    .delete(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), ne(designComponent.codeSyncStatus, "committed")))
    .returning({ id: designComponent.id });
  revalidatePath("/design-system/components");
  revalidatePath(SETTINGS_PATH);
  return { deleted: deleted.length };
}

export interface ClearCodeSyncedResult {
  ok: boolean;
  error?: string;
  prUrl?: string;
  deleted?: number;
}

export interface ReconcileWithRepoResult {
  ok: boolean;
  reset?: number;
  pendingCleared?: boolean;
  error?: string;
}

/**
 * Verifies the DB's code-sync claims against the actual design-system repo and
 * fixes drift: components no longer present in the repo (e.g. their PR branch
 * was deleted without merging) are reset to "never", and a dangling pending-PR
 * pointer is cleared. Safe to run any time.
 */
export async function reconcileWithRepo(): Promise<ReconcileWithRepoResult> {
  const workspaceId = await getCurrentWorkspaceId();
  try {
    const { reset, pendingCleared } = await reconcileCodeSyncWithRepo(workspaceId);
    revalidatePath("/design-system/components");
    revalidatePath(SETTINGS_PATH);
    return { ok: true, reset, pendingCleared };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function clearCodeSyncedComponents(): Promise<ClearCodeSyncedResult> {
  const workspaceId = await getCurrentWorkspaceId();

  try {
    // First make the DB honest about what's actually in the repo: a component
    // only ever "committed" to a since-deleted PR branch isn't there to remove,
    // so reconcile resets it -- and we then only try to delete files that
    // genuinely exist (otherwise GitHub's tree API 422s on the missing paths).
    await reconcileCodeSyncWithRepo(workspaceId);

    const committed = await db
      .select()
      .from(designComponent)
      .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.codeSyncStatus, "committed")));
    if (committed.length === 0) return { ok: true, deleted: 0 };

    // Only touch the repo (via the open PR branch, or a new one if the files
    // were merged to base) when there's genuinely something there to remove;
    // otherwise this is a DB-only cleanup and must NOT mint a branch.
    const branchName = await branchForRepoCleanup(workspaceId, (basePaths) =>
      committed.some((c) => basePaths.has(componentSourcePaths(c.slug, c.isIcon).tsxPath)),
    );

    let prUrl: string | undefined;
    if (branchName) {
      const files: CommitFile[] = committed.flatMap((c) => {
        const paths = componentSourcePaths(c.slug, c.isIcon);
        return [
          { path: paths.tsxPath, content: null },
          { path: paths.cssPath, content: null },
          { path: paths.storiesPath, content: null },
          { path: paths.indexPath, content: null },
        ];
      });
      await commitFiles(branchName, `Remove ${committed.length} component(s)`, files);
      ({ prUrl } = await finishCodeGenSession(branchName));
    }

    await db
      .delete(designComponent)
      .where(
        and(
          eq(designComponent.workspaceId, workspaceId),
          inArray(
            designComponent.id,
            committed.map((c) => c.id),
          ),
        ),
      );

    revalidatePath("/design-system/components");
    revalidatePath(SETTINGS_PATH);
    return { ok: true, prUrl, deleted: committed.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function clearUnsyncedTokens(): Promise<{ deleted: number }> {
  const workspaceId = await getCurrentWorkspaceId();
  const deleted = await db
    .delete(designToken)
    .where(and(eq(designToken.workspaceId, workspaceId), isNull(designToken.lastCodeSyncAt)))
    .returning({ id: designToken.id });
  revalidatePath("/design-system");
  revalidatePath(SETTINGS_PATH);
  return { deleted: deleted.length };
}

/**
 * Unlike components (each with its own file set that can be deleted
 * independently), tokens.css is always regenerated in FULL from whatever
 * tokens currently exist (see generateTokensCss) -- so "remove these
 * tokens from the repo" means committing a fresh tokens.css built from
 * the REMAINING tokens (computed in memory, DB untouched) and only
 * deleting the DB rows once that commit succeeds, so a GitHub-side
 * failure can't leave the repo still showing tokens the platform has
 * already forgotten.
 */
export async function clearCodeSyncedTokens(): Promise<ClearCodeSyncedResult> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws) return { ok: false, error: "Workspace not found." };

  const all = await db.select().from(designToken).where(eq(designToken.workspaceId, workspaceId));
  const codeSynced = all.filter((t) => t.lastCodeSyncAt !== null);
  if (codeSynced.length === 0) return { ok: true, deleted: 0 };
  const remaining = all.filter((t) => t.lastCodeSyncAt === null);

  try {
    // Same "no surprise branch" rule as components: commit the rebuilt
    // tokens.css only to an existing open PR branch (or a new one if tokens.css
    // is genuinely on base), else DB-only cleanup.
    const branchName = await branchForRepoCleanup(workspaceId, (basePaths) => basePaths.has("src/tokens/tokens.css"));
    let prUrl: string | undefined;
    if (branchName) {
      const tokensCss = generateTokensCss(
        remaining.map((t) => ({ name: t.name, category: t.category as DesignTokenCategory, value: t.value })),
      );
      await commitFiles(branchName, `Remove ${codeSynced.length} token(s)`, [
        { path: "src/tokens/tokens.css", content: tokensCss },
      ]);
      ({ prUrl } = await finishCodeGenSession(branchName));
    }

    await db.delete(designToken).where(
      and(
        eq(designToken.workspaceId, workspaceId),
        inArray(
          designToken.id,
          codeSynced.map((t) => t.id),
        ),
      ),
    );

    revalidatePath("/design-system");
    revalidatePath(SETTINGS_PATH);
    return { ok: true, prUrl, deleted: codeSynced.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
