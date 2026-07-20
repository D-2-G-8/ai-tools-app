"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designToken, workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { commitFiles, openOrUpdatePullRequest, mergePullRequest } from "@/lib/github/client";
import { getValidFigmaAccessToken } from "@/lib/figma/client";
import { resyncTokensFromFigma } from "@/lib/figma/sync";
import { generateTokensCss } from "@/lib/design-system-codegen/tokens";
import { loadTokensForCss } from "@/lib/design-system-codegen/data";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";

const SETTINGS_PATH = "/design-system/settings";

const PR_TITLE = "Design system: Figma sync";
const PR_BODY =
  "Opened automatically by ai-tools-app's design-system code sync. Review the CI status below, then " +
  'click "Confirm & merge" in Settings once it looks right -- this repo never auto-merges generated code.';

/**
 * Regenerates tokens.css from EVERY currently-synced token and commits it
 * -- shared by startCodeGenSession and resyncTokens below, since both do
 * exactly this. Also stamps every token row with lastCodeSyncAt: since
 * the file is always regenerated in full (see generateTokensCss), a
 * successful commit here means every token that currently exists just
 * got shipped as code, not just the ones that changed -- see
 * designToken.lastCodeSyncAt's doc comment in src/db/schema.ts and its
 * use in settings/cleanup-actions.ts (deciding whether clearing a token
 * needs a repo commit or is just a DB delete).
 */
async function commitTokensCss(workspaceId: string, branchName: string): Promise<void> {
  const tokens = await loadTokensForCss(workspaceId);
  const tokensCss = generateTokensCss(tokens);
  await commitFiles(branchName, "Update design tokens from Figma", [{ path: "src/tokens/tokens.css", content: tokensCss }]);
  await db.update(designToken).set({ lastCodeSyncAt: new Date() }).where(eq(designToken.workspaceId, workspaceId));
}

/**
 * Starts a "Generate code" session: opens (or reuses -- see
 * getOrOpenSessionBranch) a working branch and commits tokens.css first
 * (deterministic, fast, no LLM) -- must land before any component commit
 * in the same session, since components reference its CSS variables. The
 * client (design-system-codegen-panel.tsx) then calls
 * POST /api/design-system/codegen/[slug]?branch=<branchName> once per
 * component with limited concurrency, using the branch name this returns.
 */
export async function startCodeGenSession(): Promise<{ branchName: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws || ws.designComponentStack === "none") {
    throw new Error("Code generation is off for this workspace -- set a component stack in Settings first.");
  }

  const branchName = await getOrOpenSessionBranch(workspaceId);
  await commitTokensCss(workspaceId, branchName);

  return { branchName };
}

/**
 * Opens (or reuses) the pull request for a session's branch once every
 * component has been processed, and records both the PR url and the
 * branch name on the workspace -- the branch name is what lets a later
 * targeted resync ("Resync this component", "Resync tokens") land its
 * commit on this SAME not-yet-merged PR instead of opening a new one (see
 * getOrOpenSessionBranch). Never merges -- see confirmAndMergePendingPr /
 * src/lib/github/client.ts's mergePullRequest doc comment for why that's a
 * separate, explicit step.
 */
export async function finishCodeGenSession(branchName: string): Promise<{ prUrl: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const pr = await openOrUpdatePullRequest(branchName, PR_TITLE, PR_BODY);

  await db
    .update(workspace)
    .set({ designSystemPendingPrUrl: pr.htmlUrl, designSystemPendingPrBranch: branchName })
    .where(eq(workspace.id, workspaceId));
  revalidatePath(SETTINGS_PATH);

  return { prUrl: pr.htmlUrl };
}

/**
 * "Resync tokens" (Settings page): re-fetches just the Figma styles
 * listing and regenerates+commits only tokens.css -- for when only
 * colors/type/spacing changed and a full sync (which also re-lists every
 * component) isn't needed. Same session-branch/PR-reuse behavior as
 * everything else here (see getOrOpenSessionBranch).
 */
export async function resyncTokens(): Promise<{ ok: boolean; error?: string; summary?: string; prUrl?: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws) return { ok: false, error: "Workspace not found." };
  if (!ws.figmaFileKey) return { ok: false, error: "Set a Figma file key above, then sync." };

  const accessToken = await getValidFigmaAccessToken();
  if (!accessToken) {
    return { ok: false, error: "Figma isn't connected (or the connection expired) -- reconnect it above." };
  }

  try {
    const result = await resyncTokensFromFigma(workspaceId, ws.figmaFileKey, accessToken);
    const summary = `Synced ${result.tokensUpserted} token(s)${result.tokensSkipped > 0 ? ` (${result.tokensSkipped} skipped)` : ""}.`;

    if (ws.designComponentStack === "none") {
      revalidatePath(SETTINGS_PATH);
      return { ok: true, summary };
    }

    const branchName = await getOrOpenSessionBranch(workspaceId);
    await commitTokensCss(workspaceId, branchName);
    const { prUrl } = await finishCodeGenSession(branchName);

    revalidatePath(SETTINGS_PATH);
    revalidatePath("/design-system");
    return { ok: true, summary, prUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * "Confirm & merge" button -- the ONLY way generated design-system code
 * reaches the base branch (and, via that repo's own publish-on-push
 * workflow, gets published) in v1. Never called automatically.
 */
export async function confirmAndMergePendingPr(): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const prUrl = ws?.designSystemPendingPrUrl;
  if (!prUrl) throw new Error("No pending pull request to merge.");

  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`Couldn't parse a PR number out of "${prUrl}".`);

  await mergePullRequest(Number(match[1]));
  await db
    .update(workspace)
    .set({ designSystemPendingPrUrl: null, designSystemPendingPrBranch: null })
    .where(eq(workspace.id, workspaceId));

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/design-system");
  revalidatePath("/design-system/components");
}
