import { generateObject } from "ai";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import { reviewFindingsSchema, type Finding } from "./schema";
import { REVIEW_SYSTEM_PROMPT } from "./prompt";

/**
 * V1: a single model reviews the diff once. The cheapest, fastest tier --
 * intended for straightforward tickets (see the article's Section 2). No
 * cross-review/judge pass, so findings never carry `agreement`/`verdict`.
 */
export interface V1ReviewResult {
  findings: Finding[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export async function runV1Review(diffPrompt: string, model: string): Promise<V1ReviewResult> {
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
    findings: result.object.findings,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
    model,
  };
}
