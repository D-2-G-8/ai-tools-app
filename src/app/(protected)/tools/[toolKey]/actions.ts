"use server";

import { generateText } from "ai";
import { db } from "@/db";
import { promptTemplate, toolSettings, run as runTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getTool } from "@/lib/tools/registry";
import { getAnthropicClient } from "@/lib/llm/client";
import { DEFAULT_MODEL_ID, estimateCostUsd } from "@/lib/models";
import { embedTexts } from "@/lib/ingest/embed";
import { searchRelevantChunks } from "@/lib/ingest/pipeline";

export interface RunState {
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  usedContext?: boolean;
  error?: string;
}

/**
 * MVP version of the universal runner (PLAN.md, section 7, item 7).
 * Placeholder substitution in the prompt is still simplified (prompt + input +
 * context as a single block) — a full templating engine with {{variables}} for a
 * specific tool can be refined once we get to working on it separately.
 */
export async function runTool(toolKey: string, _prevState: RunState, formData: FormData): Promise<RunState> {
  const tool = getTool(toolKey);
  if (!tool) return { error: "Tool not found" };

  const promptId = String(formData.get("promptId") ?? "");
  const userInput = String(formData.get("userInput") ?? "").trim();
  const useContext = formData.get("useContext") === "on";

  if (!userInput) return { error: "Fill in the input before running" };

  const workspaceId = await getCurrentWorkspaceId();

  const [settings] = await db
    .select()
    .from(toolSettings)
    .where(and(eq(toolSettings.workspaceId, workspaceId), eq(toolSettings.toolKey, toolKey)))
    .limit(1);
  const model = settings?.model ?? DEFAULT_MODEL_ID;

  let promptContent = "";
  if (promptId) {
    const [p] = await db.select().from(promptTemplate).where(eq(promptTemplate.id, promptId)).limit(1);
    promptContent = p?.content ?? "";
  }

  let contextBlock = "";
  let usedContext = false;
  if (useContext && tool.benefitsFromContext) {
    try {
      const [embedding] = await embedTexts([userInput]);
      const rows = (await searchRelevantChunks(workspaceId, embedding, 8)) as unknown as {
        headingPath: string | null;
        content: string;
      }[];
      if (rows.length > 0) {
        contextBlock = rows
          .map((r, i) => `[${i + 1}] ${r.headingPath ? `(${r.headingPath})\n` : ""}${r.content}`)
          .join("\n\n---\n\n");
        usedContext = true;
      }
    } catch {
      // No documents/embeddings/key — just proceed without context.
    }
  }

  const promptParts = [
    promptContent,
    `Task from the user:\n${userInput}`,
    contextBlock ? `Relevant project context:\n${contextBlock}` : "",
  ].filter(Boolean);

  try {
    const anthropic = await getAnthropicClient();
    const result = await generateText({
      model: anthropic(model),
      prompt: promptParts.join("\n\n"),
    });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const costUsd = estimateCostUsd(model, inputTokens, outputTokens);

    await db.insert(runTable).values({
      workspaceId,
      toolKey,
      promptTemplateId: promptId || null,
      model,
      usedProjectContext: usedContext,
      status: "completed",
      inputSummary: userInput.slice(0, 500),
      outputSummary: result.text.slice(0, 500),
      inputTokens,
      outputTokens,
      costEstimateUsd: costUsd.toFixed(6),
    });

    return { output: result.text, inputTokens, outputTokens, costUsd, usedContext };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(runTable).values({
      workspaceId,
      toolKey,
      promptTemplateId: promptId || null,
      model,
      usedProjectContext: usedContext,
      status: "error",
      inputSummary: userInput.slice(0, 500),
      errorMessage: message,
    });
    return { error: message };
  }
}
