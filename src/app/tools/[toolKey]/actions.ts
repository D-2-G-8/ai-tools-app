"use server";

import { generateText } from "ai";
import { db } from "@/db";
import { promptTemplate, toolSettings, run as runTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
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
 * MVP-версия универсального раннера (PLAN.md, раздел 7, п.7).
 * Подстановка плейсхолдеров в промпте пока упрощённая (промпт + ввод + контекст
 * одним блоком) — полноценный шаблонизатор с {{переменными}} на конкретный
 * инструмент можно уточнить, когда дойдём до его отдельной проработки.
 */
export async function runTool(toolKey: string, _prevState: RunState, formData: FormData): Promise<RunState> {
  const tool = getTool(toolKey);
  if (!tool) return { error: "Инструмент не найден" };

  const promptId = String(formData.get("promptId") ?? "");
  const userInput = String(formData.get("userInput") ?? "").trim();
  const useContext = formData.get("useContext") === "on";

  if (!userInput) return { error: "Заполни ввод перед запуском" };

  const workspaceId = await getDefaultWorkspaceId();

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
      // Нет документов/эмбеддингов/ключа — просто работаем без контекста.
    }
  }

  const promptParts = [
    promptContent,
    `Задача от пользователя:\n${userInput}`,
    contextBlock ? `Релевантный контекст проекта:\n${contextBlock}` : "",
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
