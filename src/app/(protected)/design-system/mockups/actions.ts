"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { put, del } from "@/lib/storage";
import { db } from "@/db";
import { mockup } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { workspace } from "@/db/schema";
import { getValidFigmaAccessToken } from "@/lib/figma/client";
import {
  parseFigmaNodeId,
  discoverScreenFrames,
  syncMockupsFromFigma,
  type ScreenFrame,
  type SyncMockupsResult,
} from "@/lib/design-system-codegen/mockup-sync";

/**
 * Mockups are self-contained .html files (design-system tokens/components
 * inlined, no external asset references — see the "Mockups" tab README
 * note) stored in Blob, same access model as documents. Unlike documents
 * there is no ingest/chunking pipeline — a mockup is just stored and served.
 *
 * Mirrors app/documents/actions.ts: per-file try/catch so one bad upload in
 * a multi-file batch can't fail the rest or crash the page.
 */
export async function uploadMockup(formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();
  const files = formData.getAll("file").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    throw new Error("No files found in the form");
  }

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".html")) {
      continue;
    }

    try {
      const blob = await put(`mockups/${Date.now()}-${file.name}`, file, {
        access: "public",
        addRandomSuffix: true,
      });

      await db.insert(mockup).values({
        workspaceId,
        name: file.name.replace(/\.html$/i, ""),
        filename: file.name,
        blobUrl: blob.url,
        status: "ready",
      });
    } catch (err) {
      console.error(`Failed to upload "${file.name}":`, err);
    }
  }

  revalidatePath("/design-system/mockups");
}

/**
 * Imports existing app screens from Figma as reference mockups. Uses the Figma
 * frame URLs pasted in `urls` (one per line); if none are given, auto-discovers
 * screen frames from the file's non-service pages. See mockup-sync.ts.
 */
export async function syncMockupsFromFigmaAction(
  urls: string,
): Promise<SyncMockupsResult & { error?: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  try {
    const manual: ScreenFrame[] = urls
      .split(/[\s,]+/)
      .map((u) => parseFigmaNodeId(u))
      .filter((id): id is string => Boolean(id))
      .map((nodeId) => ({ nodeId, name: "" }));

    let frames = manual;
    if (frames.length === 0) {
      const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
      const token = await getValidFigmaAccessToken();
      if (!ws?.figmaFileKey || !token) throw new Error("Figma isn't connected, and no frame URLs were provided.");
      frames = await discoverScreenFrames(ws.figmaFileKey, token);
    }
    if (frames.length === 0) throw new Error("No screen frames found to import.");

    const result = await syncMockupsFromFigma(workspaceId, frames);
    revalidatePath("/design-system/mockups");
    return result;
  } catch (err) {
    return { imported: 0, removed: 0, errors: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteMockup(id: string) {
  const [row] = await db.select().from(mockup).where(eq(mockup.id, id)).limit(1);
  if (row) {
    // Clean up whichever Blob objects this mockup owns: the HTML page
    // (manual/ai) and/or the screenshot (a Figma reference).
    if (row.blobUrl) await del(row.blobUrl).catch(() => {});
    if (row.previewBlobUrl) await del(row.previewBlobUrl).catch(() => {});
    await db.delete(mockup).where(eq(mockup.id, id));
  }
  revalidatePath("/design-system/mockups");
}

/** Saves edited HTML content from the mockup edit page — mirrors documents/actions.ts updateDocumentContent. */
export async function updateMockupContent(id: string, formData: FormData) {
  const content = String(formData.get("content") ?? "");

  const [row] = await db.select().from(mockup).where(eq(mockup.id, id)).limit(1);
  if (!row) {
    redirect("/design-system/mockups");
  }

  const previousBlobUrl = row.blobUrl;

  try {
    const blob = await put(`mockups/${Date.now()}-${row.filename}`, content, {
      access: "public",
      addRandomSuffix: true,
    });

    await db
      .update(mockup)
      .set({ blobUrl: blob.url, status: "ready", errorMessage: null, updatedAt: new Date() })
      .where(eq(mockup.id, id));

    if (previousBlobUrl) await del(previousBlobUrl).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(mockup)
      .set({ status: "error", errorMessage: message, updatedAt: new Date() })
      .where(eq(mockup.id, id));
  }

  revalidatePath("/design-system/mockups");
  revalidatePath(`/design-system/mockups/${id}`);
  redirect(`/design-system/mockups/${id}`);
}
