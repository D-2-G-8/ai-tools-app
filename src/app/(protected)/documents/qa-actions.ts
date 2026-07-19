"use server";

import { generateText } from "ai";
import { db } from "@/db";
import { run as runTable } from "@/db/schema";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getAnthropicClient } from "@/lib/llm/client";
import { DEFAULT_MODEL_ID, estimateCostUsd } from "@/lib/models";
import { embedTexts } from "@/lib/ingest/embed";
import { searchRelevantChunks } from "@/lib/ingest/pipeline";

/**
 * Free-form Q&A over the project's uploaded documents (RAG only, no chat
 * history — each question is independent). Not part of the feature-lifecycle
 * TOOLS registry (see lib/tools/registry.ts) since it isn't a pipeline stage,
 * but every call is still logged to `run` under toolKey "documents-qa" so it
 * shows up in History/cost stats like any other LLM call.
 */

export interface DocumentsQAState {
  answer?: string;
  citations?: { filename: string; headingPath: string | null }[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}

const QA_SYSTEM_PROMPT =
  "You answer questions about a software project using only the numbered context chunks provided below, " +
  "pulled from the project's uploaded documentation. Answer strictly from that context — if it doesn't contain " +
  "the answer, say so plainly instead of guessing or using outside knowledge. When a claim relies on a chunk, " +
  "cite it inline with its number, e.g. [1]. Be concise.";

export async function askDocumentsQuestion(
  _prevState: DocumentsQAState,
  formData: FormData,
): Promise<DocumentsQAState> {
  const question = String(formData.get("question") ?? "").trim();
  if (!question) return { error: "Enter a question" };

  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();

  type ChunkRow = { headingPath: string | null; content: string; documentFilename: string };
  let rows: ChunkRow[];
  try {
    const [embedding] = await embedTexts([question]);
    rows = (await searchRelevantChunks(workspaceId, embedding, 8)) as unknown as ChunkRow[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Couldn't search the documents: ${message}` };
  }

  if (rows.length === 0) {
    return { error: "No indexed documents to search yet — upload some .md files above first." };
  }

  const contextBlock = rows
    .map((r, i) => `[${i + 1}] ${r.documentFilename}${r.headingPath ? ` — ${r.headingPath}` : ""}\n${r.content}`)
    .join("\n\n---\n\n");

  try {
    const anthropic = await getAnthropicClient();
    const result = await generateText({
      model: anthropic(DEFAULT_MODEL_ID),
      system: QA_SYSTEM_PROMPT,
      prompt: `Context:\n${contextBlock}\n\nQuestion: ${question}`,
    });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const costUsd = estimateCostUsd(DEFAULT_MODEL_ID, inputTokens, outputTokens);

    await db.insert(runTable).values({
      workspaceId,
      toolKey: "documents-qa",
      model: DEFAULT_MODEL_ID,
      userId: currentUser?.id,
      usedProjectContext: true,
      status: "completed",
      inputSummary: question.slice(0, 500),
      outputSummary: result.text.slice(0, 500),
      inputTokens,
      outputTokens,
      costEstimateUsd: costUsd.toFixed(6),
    });

    return {
      answer: result.text,
      citations: rows.map((r) => ({ filename: r.documentFilename, headingPath: r.headingPath })),
      inputTokens,
      outputTokens,
      costUsd,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(runTable).values({
      workspaceId,
      toolKey: "documents-qa",
      model: DEFAULT_MODEL_ID,
      userId: currentUser?.id,
      usedProjectContext: true,
      status: "error",
      inputSummary: question.slice(0, 500),
      errorMessage: message,
    });
    return { error: `Couldn't get an answer: ${message}` };
  }
}
