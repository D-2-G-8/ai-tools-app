"use server";

import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { openOrUpdatePullRequest } from "@/lib/github/client";

const PR_TITLE = "Design system: Figma sync";
const PR_BODY =
  "Opened automatically by ai-tools-app's design-system code sync. Review the CI status below, then " +
  'click "Confirm & merge" in Settings once it looks right -- this repo never auto-merges generated code.';

/**
 * Opens (or reuses) the pull request for a session's branch and records the PR
 * url + branch name on the workspace, so a later commit lands on the SAME PR.
 * Never merges. Extracted from the (now-removed) design-system settings so the
 * mockup screen-rebuild flow, which shares the session/PR machinery, keeps working.
 */
export async function finishCodeGenSession(branchName: string): Promise<{ prUrl: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const pr = await openOrUpdatePullRequest(branchName, PR_TITLE, PR_BODY);

  await db
    .update(workspace)
    .set({ designSystemPendingPrUrl: pr.htmlUrl, designSystemPendingPrBranch: branchName, ciAutofixAttempts: 0 })
    .where(eq(workspace.id, workspaceId));

  return { prUrl: pr.htmlUrl };
}
