import { generateObject } from "ai";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getAnthropicClient } from "@/lib/llm/client";
import { embedTexts } from "@/lib/ingest/embed";
import { estimateCostUsd } from "@/lib/models";
import {
  reviewFindingsSchema,
  reconciledFindingsSchema,
  type Finding,
  type ReconciledFinding,
} from "./schema";
import {
  RECONCILE_SYSTEM_PROMPT,
  CONTEXT_AWARE_SYSTEM_PROMPT,
  FRESH_EYES_SYSTEM_PROMPT,
  SECURITY_SYSTEM_PROMPT,
  PERFORMANCE_SYSTEM_PROMPT,
} from "./prompt";

/**
 * V3: multiple agents review the same diff from different angles, split
 * per the article/user's request into context-aware vs. context-blind:
 * - "context-aware" gets retrieved chunks from the feature's already-
 *   uploaded documents (business requirements / system analysis / ADR --
 *   see searchContextChunks below) alongside the diff, and focuses on
 *   business-logic mismatches only someone with that context could catch.
 * - "fresh-eyes" gets the diff only, reviewing it the way a new developer
 *   would on their first day, with no assumed history.
 * - "security" and "performance" are also context-blind, each with a
 *   narrow focus (per the user's explicit ask for vulnerability/
 *   performance checks independent of business logic).
 * All four run in parallel, then one judge pass reconciles everything --
 * same mechanics as V2's judge, just fed more candidate lists.
 *
 * This is the expensive tier by design (every agent reads the diff, one
 * also reads retrieved doc context, and the judge reads all four outputs)
 * -- see estimateV3CostUsd, used by the UI to show a cost estimate BEFORE
 * the user confirms running it. There is no auto-run path for V3.
 */
export interface V3AgentSpec {
  key: string;
  label: string;
  usesContext: boolean;
  systemPrompt: string;
}

export const V3_AGENTS: readonly V3AgentSpec[] = [
  { key: "context-aware", label: "Context-aware (business / ADR)", usesContext: true, systemPrompt: CONTEXT_AWARE_SYSTEM_PROMPT },
  { key: "fresh-eyes", label: "Fresh eyes (context-blind)", usesContext: false, systemPrompt: FRESH_EYES_SYSTEM_PROMPT },
  { key: "security", label: "Security-focused", usesContext: false, systemPrompt: SECURITY_SYSTEM_PROMPT },
  { key: "performance", label: "Performance-focused", usesContext: false, systemPrompt: PERFORMANCE_SYSTEM_PROMPT },
];

export const V3_DEFAULT_AGENT_MODEL = "claude-haiku-4-5";
export const V3_DEFAULT_JUDGE_MODEL = "claude-sonnet-4-5";

interface ContextChunkRow {
  headingPath: string | null;
  content: string;
}

/**
 * RAG lookup scoped to the specific documents the user picked as this
 * review's "full feature context" (see code-review-panel.tsx), NOT a
 * workspace-wide search -- deliberately narrower than
 * searchRelevantChunks() in src/lib/ingest/pipeline.ts, which has no
 * document filter. Embeds a slice of the diff itself as the query, since
 * there's no natural-language question here, just "what in these docs is
 * relevant to this change."
 */
async function searchContextChunks(workspaceId: string, documentIds: string[], queryEmbedding: number[], limit = 12): Promise<ContextChunkRow[]> {
  if (documentIds.length === 0) return [];
  const rows = await db.execute(sql`
    SELECT dc.heading_path as "headingPath", dc.content
    FROM document_chunk dc
    WHERE dc.workspace_id = ${workspaceId}
      AND dc.document_id = ANY(ARRAY[${sql.join(documentIds.map((id) => sql`${id}`), sql`, `)}]::uuid[])
      AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${JSON.stringify(queryEmbedding)}::vector
    LIMIT ${limit}
  `);
  return rows as unknown as ContextChunkRow[];
}

export interface V3AgentRun {
  key: string;
  label: string;
  findings: Finding[];
  error?: string;
}

export interface V3ReviewResult {
  findings: ReconciledFinding[];
  agentRuns: V3AgentRun[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export async function runV3Review(
  workspaceId: string,
  diffPrompt: string,
  contextDocumentIds: string[],
  agentModel: string = V3_DEFAULT_AGENT_MODEL,
  judgeModel: string = V3_DEFAULT_JUDGE_MODEL,
): Promise<V3ReviewResult> {
  let contextBlock = "";
  if (contextDocumentIds.length > 0) {
    try {
      const [embedding] = await embedTexts([diffPrompt.slice(0, 4000)]);
      const chunks = await searchContextChunks(workspaceId, contextDocumentIds, embedding, 12);
      if (chunks.length > 0) {
        contextBlock = chunks
          .map((c, i) => `[${i + 1}] ${c.headingPath ? `(${c.headingPath})\n` : ""}${c.content}`)
          .join("\n\n---\n\n");
      }
    } catch {
      // No documents selected / no embeddings key -- the context-aware
      // agent just runs without extra context rather than failing the run.
    }
  }

  const settled = await Promise.all(
    V3_AGENTS.map(async (agent) => {
      const promptText =
        agent.usesContext && contextBlock
          ? `${diffPrompt}\n\n---\nRelevant project context (business requirements / system analysis / related docs):\n${contextBlock}`
          : diffPrompt;
      try {
        const anthropic = await getAnthropicClient();
        const result = await generateObject({
          model: anthropic(agentModel),
          schema: reviewFindingsSchema,
          system: agent.systemPrompt,
          prompt: promptText,
        });
        const inputTokens = result.usage?.inputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;
        return {
          key: agent.key,
          label: agent.label,
          findings: result.object.findings,
          inputTokens,
          outputTokens,
          costUsd: estimateCostUsd(agentModel, inputTokens, outputTokens),
        };
      } catch (err) {
        return {
          key: agent.key,
          label: agent.label,
          findings: [] as Finding[],
          error: err instanceof Error ? err.message : String(err),
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }
    }),
  );

  const agentRuns: V3AgentRun[] = settled.map((s) => ({ key: s.key, label: s.label, findings: s.findings, error: s.error }));
  let inputTokens = settled.reduce((sum, s) => sum + s.inputTokens, 0);
  let outputTokens = settled.reduce((sum, s) => sum + s.outputTokens, 0);
  let costUsd = settled.reduce((sum, s) => sum + s.costUsd, 0);

  const ok = settled.filter((s) => !s.error);
  if (ok.length === 0) {
    throw new Error(`All V3 agents failed: ${settled.map((s) => `${s.label}: ${s.error}`).join("; ")}`);
  }
  if (ok.every((s) => s.findings.length === 0)) {
    return {
      findings: [],
      agentRuns,
      inputTokens,
      outputTokens,
      costUsd,
      model: `v3 (${agentModel} x${V3_AGENTS.length}, no findings — judge skipped)`,
    };
  }

  const candidatesBlock = ok.map((s) => `### ${s.label} findings:\n${JSON.stringify(s.findings, null, 2)}`).join("\n\n");
  const judgePrompt =
    `${diffPrompt}\n\n---\n` +
    "Below are several independent reviewers' findings on the diff above (some with full feature context, " +
    "some without, some focused on security/performance). Verify, deduplicate and reconcile them.\n\n" +
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
    agentRuns,
    inputTokens,
    outputTokens,
    costUsd,
    model: `v3 (${agentModel} x${V3_AGENTS.length}, judge: ${judgeModel})`,
  };
}

/**
 * Rough pre-run cost estimate shown in the UI before the user confirms a
 * V3 run (manual-trigger-only, per the cost-optimization requirement --
 * see PLAN.md's worked cost example for the ~4-chars-per-token heuristic
 * used here). Not exact -- just enough to show "roughly $X" so the user
 * isn't running this blind.
 */
export function estimateV3CostUsd(diffChars: number, contextChars: number, agentModel: string, judgeModel: string): number {
  const CHARS_PER_TOKEN = 4;
  const PER_AGENT_OUTPUT_TOKENS = 600;
  const JUDGE_OUTPUT_TOKENS = 800;

  const diffTokens = Math.ceil(diffChars / CHARS_PER_TOKEN);
  const contextTokens = Math.ceil(contextChars / CHARS_PER_TOKEN);

  let agentInputTokens = 0;
  for (const agent of V3_AGENTS) {
    agentInputTokens += diffTokens + (agent.usesContext ? contextTokens : 0);
  }
  const agentOutputTokens = V3_AGENTS.length * PER_AGENT_OUTPUT_TOKENS;
  const agentsCost = estimateCostUsd(agentModel, agentInputTokens, agentOutputTokens);

  // The judge reads the diff plus every agent's JSON findings -- roughly
  // approximated as diff + total agent output tokens.
  const judgeInputTokens = diffTokens + agentOutputTokens;
  const judgeCost = estimateCostUsd(judgeModel, judgeInputTokens, JUDGE_OUTPUT_TOKENS);

  return agentsCost + judgeCost;
}
