"use server";

import { generateText } from "ai";
import { db } from "@/db";
import { run as runTable } from "@/db/schema";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getAnthropicClient } from "@/lib/llm/client";
import { DEFAULT_MODEL_ID, estimateCostUsd } from "@/lib/models";
import { loadDocumentForWorkspace, loadDocumentContent } from "./shared";

/**
 * AI-assisted markdown cleanup for a single document -- see the "Format"
 * button on the document view page. Not part of the feature-lifecycle TOOLS
 * registry (see lib/tools/registry.ts), same as documents-qa: it's a
 * one-off utility action, not a pipeline stage, but every call is still
 * logged to `run` under toolKey "document-format" so it shows up in
 * History/cost stats like any other LLM call.
 *
 * This only ever returns a PROPOSED result -- it never writes to the
 * document itself. The document view page's format-preview panel shows the
 * result and lets the user Apply (which reuses updateDocumentContent, the
 * same save path as the manual editor) or Cancel (discard, no server call
 * at all).
 */

export interface FormatDocumentState {
  formatted?: string;
  error?: string;
}

const FORMAT_SYSTEM_PROMPT = `You clean up the formatting of a markdown document. These documents often come \
from an export/conversion step that leaves formatting broken -- most commonly tables (misaligned pipes, a \
missing "---" header separator row, rows with the wrong number of columns, cell content wrapped across lines), \
but also inconsistent heading levels, stray blank lines, and malformed lists.

Rewrite the ENTIRE document as clean, valid, well-formatted Markdown:
- Fix broken tables: every row must have the same number of columns as the header, with a proper "---" \
separator row right after the header row.
- Fix heading levels, spacing, list markers/indentation, and stray blank lines.
- Preserve all actual content, wording, and meaning EXACTLY -- do not summarize, add, remove, or reword \
anything. This is a formatting pass only.
- Preserve fenced code blocks (including \`\`\`bpmn / \`\`\`mermaid diagram blocks) and image references \
(![alt](src)) character for character, exactly as-is -- never touch anything inside a fenced block or an \
image reference.
- Output ONLY the reformatted markdown document itself -- no preamble, no explanation, no commentary, and do \
not wrap the whole output in its own code fence.`;

export async function formatDocumentContent(
  documentId: string,
  // useActionState calls this as (prevState, formData) after the bound
  // documentId -- neither is needed here (there's no form data, and the
  // previous state doesn't affect a fresh format run), but both params
  // must stay declared so the bound function's shape still matches what
  // useActionState/<form action> expects to call.
  prevState: FormatDocumentState,
  formData: FormData,
): Promise<FormatDocumentState> {
  void prevState;
  void formData;
  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();

  const doc = await loadDocumentForWorkspace(documentId);
  if (!doc) return { error: "Document not found" };

  const { content, error: loadError } = await loadDocumentContent(doc.blobUrl);
  if (loadError || content === undefined) {
    return { error: loadError ?? "Couldn't load the document content" };
  }
  if (!content.trim()) {
    return { error: "The document is empty -- nothing to format" };
  }

  try {
    const anthropic = await getAnthropicClient();
    const result = await generateText({
      model: anthropic(DEFAULT_MODEL_ID),
      system: FORMAT_SYSTEM_PROMPT,
      prompt: content,
    });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const costUsd = estimateCostUsd(DEFAULT_MODEL_ID, inputTokens, outputTokens);

    await db.insert(runTable).values({
      workspaceId,
      toolKey: "document-format",
      model: DEFAULT_MODEL_ID,
      userId: currentUser?.id,
      status: "completed",
      inputSummary: `Format "${doc.filename}"`.slice(0, 500),
      outputSummary: result.text.slice(0, 500),
      inputTokens,
      outputTokens,
      costEstimateUsd: costUsd.toFixed(6),
    });

    const formatted = result.text.trim();
    if (!formatted) {
      return { error: "The model returned an empty result -- nothing was changed" };
    }
    return { formatted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.insert(runTable).values({
      workspaceId,
      toolKey: "document-format",
      model: DEFAULT_MODEL_ID,
      userId: currentUser?.id,
      status: "error",
      inputSummary: `Format "${doc.filename}"`.slice(0, 500),
      errorMessage: message,
    });
    return { error: `Couldn't format the document: ${message}` };
  }
}
