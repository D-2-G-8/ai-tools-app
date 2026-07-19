"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { run as runTable, workspace, type CodeReviewFindingRecord } from "@/db/schema";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getSession } from "@/lib/session";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { listOpenMergeRequests, fetchMrDiff, postMrComment, describeGitlabError, type GitlabAuth, type GitlabProjectMrs } from "@/lib/gitlab/client";
import { buildDiffPrompt } from "@/lib/code-review/prompt";
import { runV1Review } from "@/lib/code-review/v1";
import { runV2Review, V2_DEFAULT_REVIEWER_MODELS, V2_DEFAULT_JUDGE_MODEL } from "@/lib/code-review/v2";
import { runV3Review, V3_DEFAULT_AGENT_MODEL, V3_DEFAULT_JUDGE_MODEL, estimateV3CostUsd } from "@/lib/code-review/v3";
import { formatReviewComment } from "@/lib/code-review/format";
import { type ReviewVersion } from "@/lib/code-review/schema";

const REVIEW_TOOL_KEY = "code-review";

export interface GitlabReadiness {
  ready: boolean;
  message?: string;
  gitlabUrl?: string;
  projectIds: string[];
}

/** Resolves whether AI Review can run yet -- see the "GitLab and LLM provider" section on Settings. */
export async function getGitlabReadiness(): Promise<GitlabReadiness> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const session = await getSession();

  const gitlabUrl = ws?.gitlabUrl?.trim();
  const projectIds = (ws?.gitlabProjectIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const token = session.gitlabToken;

  if (!gitlabUrl || projectIds.length === 0 || !token) {
    const missing = [
      !gitlabUrl && "GitLab URL",
      projectIds.length === 0 && "GitLab project IDs",
      !token && "GitLab personal access token",
    ]
      .filter(Boolean)
      .join(", ");
    return { ready: false, message: `Set ${missing} in Settings to use AI Review.`, projectIds };
  }

  return { ready: true, gitlabUrl, projectIds };
}

export async function loadOpenMergeRequests(): Promise<{ readiness: GitlabReadiness; projects: GitlabProjectMrs[] }> {
  const readiness = await getGitlabReadiness();
  if (!readiness.ready || !readiness.gitlabUrl) {
    return { readiness, projects: [] };
  }
  const session = await getSession();
  const auth: GitlabAuth = { gitlabUrl: readiness.gitlabUrl, token: session.gitlabToken! };
  const projects = await listOpenMergeRequests(auth, readiness.projectIds);
  return { readiness, projects };
}

async function requireGitlabAuth(): Promise<GitlabAuth> {
  const readiness = await getGitlabReadiness();
  if (!readiness.ready || !readiness.gitlabUrl) {
    throw new Error(readiness.message ?? "GitLab is not configured yet -- see Settings.");
  }
  const session = await getSession();
  return { gitlabUrl: readiness.gitlabUrl, token: session.gitlabToken! };
}

export interface RunReviewState {
  runId?: string;
  findings?: CodeReviewFindingRecord[];
  costUsd?: number;
  truncated?: boolean;
  mrTitle?: string;
  error?: string;
}

/**
 * Runs V1/V2/V3 against a specific MR's live diff and logs the result to
 * `run` (toolKey "code-review") -- same run-table logging every other tool
 * uses, so this shows up in Stats/History for free. Bind with
 * .bind(null, projectId, iid, version) before passing to useActionState
 * (see code-review-panel.tsx), same pattern as saveToolModel.bind(null, tool.key)
 * on the Settings page.
 */
export async function runReview(
  projectId: string,
  iid: number,
  version: ReviewVersion,
  _prevState: RunReviewState,
  formData: FormData,
): Promise<RunReviewState> {
  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();

  let auth: GitlabAuth;
  try {
    auth = await requireGitlabAuth();
  } catch (err) {
    return { error: describeGitlabError(err) };
  }

  try {
    const diffFiles = await fetchMrDiff(auth, projectId, iid);
    if (diffFiles.length === 0) {
      return { error: "This MR has no changes -- nothing to review." };
    }

    const mrTitle = String(formData.get("mrTitle") ?? "");
    const sourceBranch = String(formData.get("sourceBranch") ?? "?");
    const targetBranch = String(formData.get("targetBranch") ?? "?");
    const { prompt: diffPrompt, truncated } = buildDiffPrompt(
      { title: mrTitle, projectLabel: projectId, sourceBranch, targetBranch },
      diffFiles,
    );

    let findings: CodeReviewFindingRecord[];
    let model: string;
    let inputTokens: number;
    let outputTokens: number;
    let costUsd: number;

    if (version === "v1") {
      const effectiveModel = await getEffectiveModel(workspaceId, REVIEW_TOOL_KEY);
      const result = await runV1Review(diffPrompt, effectiveModel);
      findings = result.findings;
      model = result.model;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      costUsd = result.costUsd;
    } else if (version === "v2") {
      const result = await runV2Review(diffPrompt, V2_DEFAULT_REVIEWER_MODELS, V2_DEFAULT_JUDGE_MODEL);
      findings = result.findings;
      model = result.model;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      costUsd = result.costUsd;
    } else {
      const contextDocumentIds = formData.getAll("contextDoc").map(String);
      const result = await runV3Review(workspaceId, diffPrompt, contextDocumentIds, V3_DEFAULT_AGENT_MODEL, V3_DEFAULT_JUDGE_MODEL);
      findings = result.findings;
      model = result.model;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      costUsd = result.costUsd;
    }

    const [savedRun] = await db
      .insert(runTable)
      .values({
        workspaceId,
        toolKey: REVIEW_TOOL_KEY,
        model,
        userId: currentUser?.id,
        status: "completed",
        inputSummary: `${version.toUpperCase()} review of ${projectId}!${iid}${mrTitle ? ` — ${mrTitle}` : ""}`.slice(0, 500),
        outputSummary: `${findings.length} finding(s)`,
        gitlabProjectId: projectId,
        gitlabMrIid: String(iid),
        reviewVersion: version,
        findingsJson: findings,
        inputTokens,
        outputTokens,
        costEstimateUsd: costUsd.toFixed(6),
      })
      .returning();

    revalidatePath(`/tools/${REVIEW_TOOL_KEY}`);
    return { runId: savedRun.id, findings, costUsd, truncated, mrTitle };
  } catch (err) {
    const message = describeGitlabError(err);
    await db.insert(runTable).values({
      workspaceId,
      toolKey: REVIEW_TOOL_KEY,
      model: version,
      userId: currentUser?.id,
      status: "error",
      inputSummary: `${version.toUpperCase()} review of ${projectId}!${iid}`.slice(0, 500),
      gitlabProjectId: projectId,
      gitlabMrIid: String(iid),
      reviewVersion: version,
      errorMessage: message,
    });
    return { error: message };
  }
}

export interface EstimateV3State {
  estimatedCostUsd?: number;
  error?: string;
}

/**
 * Rough pre-run cost estimate for V3, shown before the "Run" button is
 * enabled (V3 is manual-trigger-only and explicitly the expensive tier --
 * see estimateV3CostUsd's own comment). Fetches the real diff (cheap, no
 * LLM call) so the estimate is based on the MR's actual size, and
 * approximates selected documents' context size from their already-known
 * chunkCount rather than fetching chunk text.
 */
export async function estimateV3Review(
  projectId: string,
  iid: number,
  _prevState: EstimateV3State,
  formData: FormData,
): Promise<EstimateV3State> {
  try {
    const auth = await requireGitlabAuth();
    const diffFiles = await fetchMrDiff(auth, projectId, iid);
    const { prompt: diffPrompt } = buildDiffPrompt(
      { title: "", projectLabel: projectId, sourceBranch: "?", targetBranch: "?" },
      diffFiles,
    );

    const contextDocumentIds = formData.getAll("contextDoc").map(String);
    let contextChars = 0;
    if (contextDocumentIds.length > 0) {
      const { document } = await import("@/db/schema");
      const { inArray } = await import("drizzle-orm");
      const docs = await db.select({ chunkCount: document.chunkCount }).from(document).where(inArray(document.id, contextDocumentIds));
      // Rough average of ~700 chars per chunk (heading + a paragraph or two).
      contextChars = docs.reduce((sum, d) => sum + d.chunkCount * 700, 0);
    }

    const estimatedCostUsd = estimateV3CostUsd(diffPrompt.length, contextChars, V3_DEFAULT_AGENT_MODEL, V3_DEFAULT_JUDGE_MODEL);
    return { estimatedCostUsd };
  } catch (err) {
    return { error: describeGitlabError(err) };
  }
}

export interface PostToGitlabState {
  posted?: boolean;
  error?: string;
}

/**
 * Explicit, separate "Post to MR" step -- deliberately NOT bundled into
 * runReview (the Python prototype's single button reviews AND posts in one
 * click; this lets the user check the findings first, per the plan).
 */
export async function postReviewToGitlab(runId: string, _prevState: PostToGitlabState, _formData: FormData): Promise<PostToGitlabState> {
  void _prevState;
  void _formData;
  const workspaceId = await getCurrentWorkspaceId();
  const [existing] = await db.select().from(runTable).where(eq(runTable.id, runId)).limit(1);

  if (!existing || existing.workspaceId !== workspaceId) {
    return { error: "Review not found" };
  }
  if (!existing.gitlabProjectId || !existing.gitlabMrIid) {
    return { error: "This run has no associated MR" };
  }

  try {
    const auth = await requireGitlabAuth();
    const findings = existing.findingsJson ?? [];
    const comment = formatReviewComment(findings, false);
    await postMrComment(auth, existing.gitlabProjectId, Number(existing.gitlabMrIid), comment);

    await db.update(runTable).set({ postedToGitlabAt: new Date() }).where(eq(runTable.id, runId));
    revalidatePath(`/tools/${REVIEW_TOOL_KEY}`);
    return { posted: true };
  } catch (err) {
    return { error: describeGitlabError(err) };
  }
}
