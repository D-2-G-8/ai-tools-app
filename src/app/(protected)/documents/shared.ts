import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { document } from "@/db/schema";
import { getCurrentWorkspaceId } from "@/db/workspace";

/**
 * Shared between the documents list, view, and edit pages so the three
 * don't drift out of sync on status labels/colors or how a single document
 * (and its Blob content) is loaded.
 */

export const statusLabel: Record<string, string> = {
  processing: "processing",
  ready: "ready",
  error: "error",
};

export const statusClass: Record<string, string> = {
  processing: "bg-amber-100 text-amber-700",
  ready: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
};

export async function loadDocumentForWorkspace(id: string) {
  const workspaceId = await getCurrentWorkspaceId();
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.workspaceId, workspaceId)))
    .limit(1);
  return doc;
}

/**
 * Fetches the raw markdown straight from Blob. Must never throw — a bad or
 * expired blob URL should render an inline error on the page, not crash it.
 */
export async function loadDocumentContent(blobUrl: string): Promise<{ content?: string; error?: string }> {
  try {
    const res = await fetch(blobUrl, { cache: "no-store" });
    if (!res.ok) return { error: `Failed to download the file (${res.status})` };
    return { content: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
