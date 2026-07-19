"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { put, del } from "@vercel/blob";
import { generateText } from "ai";
import { db } from "@/db";
import {
  run as runTable,
  chatMessage,
  document,
  featureWorkflow,
  featureWorkflowDocument,
  promptTemplate,
} from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getTool } from "@/lib/tools/registry";
import { ensureDefaultPrompts } from "@/lib/tools/prompts";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import { embedTexts } from "@/lib/ingest/embed";
import { searchRelevantChunks, ingestMarkdownDocument } from "@/lib/ingest/pipeline";

/**
 * Chat-style interview runner for tools with `chatMode: true` (currently only
 * Business Requirements). One `run` row = one conversation; individual turns
 * live in `chat_message`. See PLAN.md and business-requirements-template.ts
 * for the interview design.
 *
 * The model signals a finished document by starting its reply with this exact
 * line — see business-requirements-template.ts, "WHEN THE DOCUMENT IS READY".
 */
const DOCUMENT_READY_MARKER = "DOCUMENT_READY";

type RunRow = typeof runTable.$inferSelect;
type ChatMessageRow = typeof chatMessage.$inferSelect;

async function getActiveSystemPrompt(toolKey: string): Promise<string> {
  await ensureDefaultPrompts(toolKey);
  const workspaceId = await getCurrentWorkspaceId();
  const [active] = await db
    .select()
    .from(promptTemplate)
    .where(
      and(
        eq(promptTemplate.workspaceId, workspaceId),
        eq(promptTemplate.toolKey, toolKey),
        eq(promptTemplate.isActive, true),
      ),
    )
    .limit(1);

  const content = active?.content ?? "";
  // Only placeholder currently supported — see README "Known limitations"
  // regarding the lack of a general {{var}} templating engine.
  const today = new Date().toISOString().slice(0, 10);
  return content.split("{{TODAY}}").join(today);
}

function buildTranscript(messages: { role: string; content: string }[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

async function fetchProjectContext(
  workspaceId: string,
  query: string,
): Promise<{ block: string; used: boolean }> {
  try {
    const [embedding] = await embedTexts([query]);
    const rows = (await searchRelevantChunks(workspaceId, embedding, 8)) as unknown as {
      headingPath: string | null;
      content: string;
    }[];
    if (rows.length === 0) return { block: "", used: false };
    const block = rows
      .map((r, i) => `[${i + 1}] ${r.headingPath ? `(${r.headingPath})\n` : ""}${r.content}`)
      .join("\n\n---\n\n");
    return { block, used: true };
  } catch {
    // No documents / embeddings / key yet — proceed without context.
    return { block: "", used: false };
  }
}

/**
 * Uploads the compiled markdown as a project document (Blob + ingest into
 * RAG, same pipeline as a manual upload on the Documents page) and links it
 * to the run's feature. On a *second* completion of the same run (the user
 * kept chatting after the doc was ready, refining it), this updates the
 * existing document in place instead of creating a duplicate.
 */
async function finalizeDocument({
  run,
  workspaceId,
  markdown,
}: {
  run: RunRow;
  workspaceId: string;
  markdown: string;
}) {
  const feature = run.featureWorkflowId
    ? (await db.select().from(featureWorkflow).where(eq(featureWorkflow.id, run.featureWorkflowId)).limit(1))[0]
    : undefined;
  const baseName = (feature?.name || "business-requirements").replace(/[\\/]/g, "-").slice(0, 80);
  const filename = `${baseName}.md`;

  const blob = await put(`documents/${Date.now()}-${filename}`, markdown, {
    access: "public",
    addRandomSuffix: true,
  });

  let docId: string;
  if (run.resultDocumentId) {
    const [existing] = await db.select().from(document).where(eq(document.id, run.resultDocumentId)).limit(1);
    await db
      .update(document)
      .set({ filename, blobUrl: blob.url, status: "processing", errorMessage: null, updatedAt: new Date() })
      .where(eq(document.id, run.resultDocumentId));
    docId = run.resultDocumentId;
    if (existing?.blobUrl) {
      await del(existing.blobUrl).catch(() => {});
    }
  } else {
    const [inserted] = await db
      .insert(document)
      .values({ workspaceId, filename, format: "md", blobUrl: blob.url, status: "processing" })
      .returning();
    docId = inserted.id;
  }

  try {
    await ingestMarkdownDocument(docId);
  } catch {
    // Status is already marked "error" inside ingestMarkdownDocument — the
    // run still gets a resultDocumentId, it just won't be searchable via RAG
    // until "Retry processing" succeeds on the Documents page.
  }

  if (run.featureWorkflowId) {
    await db
      .insert(featureWorkflowDocument)
      .values({
        featureWorkflowId: run.featureWorkflowId,
        documentId: docId,
        relevanceNote: "Generated by the Business Requirements tool",
      })
      .onConflictDoNothing();
  }

  return docId;
}

/**
 * Runs one interview turn end to end: persists the user's message, calls the
 * model with the full transcript, persists the reply, and — if the model
 * signals the document is ready — finalizes it. Every failure path here is
 * caught and turned into a visible chat message + run.status = "error"
 * instead of throwing, so a model/Blob/DB hiccup can never crash the whole
 * page the way the undocumented-Blob-store bug once did.
 */
async function runInterviewTurn({
  toolKey,
  run,
  workspaceId,
  priorMessages,
  userMessage,
}: {
  toolKey: string;
  run: RunRow;
  workspaceId: string;
  priorMessages: ChatMessageRow[];
  userMessage: string;
}) {
  await db.insert(chatMessage).values({ runId: run.id, role: "user", content: userMessage });

  try {
    // There is no "delete a tool setting" action, so if a setting existed
    // when this run started (see startChat below) it's still there now --
    // getEffectiveModel's own fallback chain (personal -> legacy company
    // default -> DEFAULT_MODEL_ID) is enough without also falling back to
    // run.model here.
    const model = await getEffectiveModel(workspaceId, toolKey);

    const systemPrompt = await getActiveSystemPrompt(toolKey);
    const { block: contextBlock, used: usedContext } = await fetchProjectContext(workspaceId, userMessage);

    const transcript = buildTranscript([
      ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ]);

    const promptParts = [
      contextBlock ? `Project context (use if helpful, not required):\n${contextBlock}` : "",
      `Conversation so far:\n${transcript}`,
      "Reply to the user's latest message, strictly following the role and instructions from the system prompt.",
    ].filter(Boolean);

    const anthropic = await getAnthropicClient();
    const result = await generateText({
      model: anthropic(model),
      system: systemPrompt,
      prompt: promptParts.join("\n\n"),
    });

    const inputTokens = (run.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0);
    const outputTokens = (run.outputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    const costUsd =
      Number(run.costEstimateUsd) + estimateCostUsd(model, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);

    const raw = result.text.trim();
    const isReady = raw.startsWith(DOCUMENT_READY_MARKER);

    if (isReady) {
      const markdown = raw.slice(DOCUMENT_READY_MARKER.length).trim();
      await db.insert(chatMessage).values({
        runId: run.id,
        role: "assistant",
        content: "Done! The document has been compiled — find it on the Documents page or the link below.",
      });

      const resultDocumentId = await finalizeDocument({ run, workspaceId, markdown });

      await db
        .update(runTable)
        .set({
          status: "completed",
          model,
          usedProjectContext: run.usedProjectContext || usedContext,
          inputTokens,
          outputTokens,
          costEstimateUsd: costUsd.toFixed(6),
          outputSummary: markdown.slice(0, 500),
          resultDocumentId,
          errorMessage: null,
        })
        .where(eq(runTable.id, run.id));
    } else {
      await db.insert(chatMessage).values({ runId: run.id, role: "assistant", content: raw });

      await db
        .update(runTable)
        .set({
          status: "running",
          model,
          usedProjectContext: run.usedProjectContext || usedContext,
          inputTokens,
          outputTokens,
          costEstimateUsd: costUsd.toFixed(6),
        })
        .where(eq(runTable.id, run.id));
    }
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    await db.insert(chatMessage).values({
      runId: run.id,
      role: "assistant",
      content: `Could not get a response from the model: ${messageText}`,
    });
    await db.update(runTable).set({ status: "error", errorMessage: messageText }).where(eq(runTable.id, run.id));
  }
}

export interface ChatActionState {
  error?: string;
}

/**
 * Starts a brand-new conversation from the very first message — no separate
 * "name your feature" step, matching the tool's chat-first UX. Creates a
 * feature_workflow (unless `featureWorkflowId` was passed, e.g. continuing a
 * feature from History that has no business-requirements run yet) and a run,
 * then redirects to it. Validation issues are returned as state (not thrown)
 * so a mistyped form never falls through to the generic error page.
 */
export async function startChat(
  toolKey: string,
  _prevState: ChatActionState,
  formData: FormData,
): Promise<ChatActionState> {
  const tool = getTool(toolKey);
  if (!tool || !tool.chatMode) return { error: "This tool does not support chat mode" };

  const message = String(formData.get("message") ?? "").trim();
  if (!message) return { error: "Enter a message to start" };

  const workspaceId = await getCurrentWorkspaceId();
  const existingFeatureId = String(formData.get("featureWorkflowId") ?? "").trim();

  let featureWorkflowId = existingFeatureId || null;
  if (!featureWorkflowId) {
    const name = message.length > 80 ? `${message.slice(0, 77)}…` : message;
    const [feature] = await db
      .insert(featureWorkflow)
      .values({ workspaceId, name, currentStage: toolKey, status: "in_progress" })
      .returning();
    featureWorkflowId = feature.id;
  }

  const currentUser = await getCurrentUser();
  const model = await getEffectiveModel(workspaceId, toolKey);

  const [newRun] = await db
    .insert(runTable)
    .values({
      workspaceId,
      toolKey,
      featureWorkflowId,
      model,
      userId: currentUser?.id,
      status: "running",
      inputSummary: message.slice(0, 300),
    })
    .returning();

  await runInterviewTurn({ toolKey, run: newRun, workspaceId, priorMessages: [], userMessage: message });

  revalidatePath(`/tools/${toolKey}`);
  redirect(`/tools/${toolKey}?run=${newRun.id}`);
}

/** Continues an existing conversation with one more user message. */
export async function sendChatMessage(
  toolKey: string,
  runId: string,
  _prevState: ChatActionState,
  formData: FormData,
): Promise<ChatActionState> {
  const message = String(formData.get("message") ?? "").trim();
  if (!message) return { error: "Enter a message" };

  const workspaceId = await getCurrentWorkspaceId();
  const [existingRun] = await db.select().from(runTable).where(eq(runTable.id, runId)).limit(1);
  if (!existingRun) return { error: "Conversation not found" };

  const priorMessages = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.runId, runId))
    .orderBy(asc(chatMessage.createdAt));

  await runInterviewTurn({ toolKey, run: existingRun, workspaceId, priorMessages, userMessage: message });

  revalidatePath(`/tools/${toolKey}`);
  return {};
}
