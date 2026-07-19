import { generateObject } from "ai";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import {
  reviewFindingsSchema,
  reconciledFindingsSchema,
  type Finding,
  type ReconciledFinding,
} from "./schema";
import { REVIEW_SYSTEM_PROMPT, RECONCILE_SYSTEM_PROMPT } from "./prompt";

/**
 * V2: two models review the SAME diff independently and in parallel (each
 * blind to the other's output), then a judge model reconciles the two
 * finding sets against the diff -- merging duplicates, confirming what it
 * can verify, and marking agreed-but-unconfirmed findings as
 * "needs_verification" rather than silently dropping them (see the
 * article's Section 2: "agreement between two independent reviewers turned
 * out to be a strong signal on its own").
 *
 * Cost notes:
 * - Defaults to Haiku + Sonnet as the two reviewers (not two Sonnets/Opus
 *   like the reference Python prototype) -- cheaper, and using two
 *   different models is itself the point: different models have different
 *   blind spots, so their overlap is a stronger signal than two identical
 *   passes.
 * - The judge is Sonnet, not Opus -- "cheaper by default" per the user's
 *   answer; Opus stays available as a per-tool model override in Settings
 *   for anyone who wants it.
 * - If BOTH reviewers return zero findings, the judge call is skipped
 *   entirely -- there is nothing to reconcile, so paying for a third call
 *   would be pure waste.
 */
export const V2_DEFAULT_REVIEWER_MODELS: readonly string[] = ["claude-haiku-4-5", "claude-sonnet-4-5"];
export const V2_DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

export interface ReviewerRun {
  model: string;
  findings: Finding[];
  error?: string;
}

export interface V2ReviewResult {
  findings: ReconciledFinding[];
  reviewerRuns: ReviewerRun[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

async function runSingleReviewer(diffPrompt: string, model: string): Promise<ReviewerRun & { inputTokens: number; outputTokens: number; costUsd: number }> {
  try {
    const anthropic = await getAnthropicClient();
    const result = await generateObject({
      model: anthropic(model),
      schema: reviewFindingsSchema,
      system: REVIEW_SYSTEM_PROMPT,
      prompt: diffPrompt,
    });
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    return {
      model,
      findings: result.object.findings,
      inputTokens,
      outputTokens,
      costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    };
  } catch (err) {
    return {
      model,
      findings: [],
      error: err instanceof Error ? err.message : String(err),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }
}

export async function runV2Review(
  diffPrompt: string,
  reviewerModels: readonly string[] = V2_DEFAULT_REVIEWER_MODELS,
  judgeModel: string = V2_DEFAULT_JUDGE_MODEL,
): Promise<V2ReviewResult> {
  const settled = await Promise.all(reviewerModels.map((model) => runSingleReviewer(diffPrompt, model)));

  const reviewerRuns: ReviewerRun[] = settled.map((s) => ({ model: s.model, findings: s.findings, error: s.error }));
  let inputTokens = settled.reduce((sum, s) => sum + s.inputTokens, 0);
  let outputTokens = settled.reduce((sum, s) => sum + s.outputTokens, 0);
  let costUsd = settled.reduce((sum, s) => sum + s.costUsd, 0);

  const ok = settled.filter((s) => !s.error);
  if (ok.length === 0) {
    throw new Error(`All V2 reviewers failed: ${settled.map((s) => `${s.model}: ${s.error}`).join("; ")}`);
  }

  if (ok.length === 1) {
    // Nothing to reconcile against -- return the sole survivor's findings
    // as-is (agreement 1, confirmed -- there's no second opinion to weigh).
    const only = ok[0];
    return {
      findings: only.findings.map((f) => ({ ...f, agreement: 1, verdict: "confirmed" as const })),
      reviewerRuns,
      inputTokens,
      outputTokens,
      costUsd,
      model: `v2 (${only.model} only — other reviewer failed)`,
    };
  }

  if (ok.every((s) => s.findings.length === 0)) {
    // Cost optimization: nothing for a judge to reconcile.
    return {
      findings: [],
      reviewerRuns,
      inputTokens,
      outputTokens,
      costUsd,
      model: `v2 (${reviewerModels.join(" + ")}, no findings — judge skipped)`,
    };
  }

  const candidatesBlock = ok
    .map((s, i) => `### Reviewer ${i + 1} (${s.model}) findings:\n${JSON.stringify(s.findings, null, 2)}`)
    .join("\n\n");
  const judgePrompt =
    `${diffPrompt}\n\n---\n` +
    "Below are the independent reviewers' findings on the diff above. Verify, deduplicate and reconcile them.\n\n" +
    candidatesBlock;

  const anthropic = await getAnthropicClient();
  const judged = await generateObject({
    model: anthropic(judgeModel),
    schema: reconciledFindingsSchema,
    system: RECONCILE_SYSTEM_PROMPT,
    prompt: judgePrompt,
  });
  const judgeInputTokens = judged.usage?.inputTokens ?? 0;
  const judgeOutputTokens = judged.usage?.outputTokens ?? 0;
  inputTokens += judgeInputTokens;
  outputTokens += judgeOutputTokens;
  costUsd += estimateCostUsd(judgeModel, judgeInputTokens, judgeOutputTokens);

  return {
    findings: judged.object.findings,
    reviewerRuns,
    inputTokens,
    outputTokens,
    costUsd,
    model: `v2 (${reviewerModels.join(" + ")}, judge: ${judgeModel})`,
  };
}
