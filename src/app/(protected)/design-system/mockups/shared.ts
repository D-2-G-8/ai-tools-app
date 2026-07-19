import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mockup } from "@/db/schema";
import { getCurrentWorkspaceId } from "@/db/workspace";

/** Shared between the mockups list, view, edit, render, and download routes. */

export const mockupStatusClass: Record<string, string> = {
  ready: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
};

export async function loadMockupForWorkspace(id: string) {
  const workspaceId = await getCurrentWorkspaceId();
  const [row] = await db
    .select()
    .from(mockup)
    .where(and(eq(mockup.id, id), eq(mockup.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

/**
 * Fetches the raw HTML straight from Blob. Must never throw — a bad or
 * expired blob URL should render an inline error, not crash the page.
 */
export async function loadMockupContent(blobUrl: string): Promise<{ content?: string; error?: string }> {
  try {
    const res = await fetch(blobUrl, { cache: "no-store" });
    if (!res.ok) return { error: `Failed to download the file (${res.status})` };
    return { content: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
