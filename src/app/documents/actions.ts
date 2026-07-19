"use server";

import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { db } from "@/db";
import { document } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { ingestMarkdownDocument } from "@/lib/ingest/pipeline";

/**
 * MVP: .md only, server-side upload (via Server Action, files in FormData).
 * For files larger than a few MB, switch to client-side upload
 * (@vercel/blob client upload) — see the README "Known limitations".
 *
 * Supports uploading several files at once (the <input> has `multiple`).
 * Files are processed one by one, sequentially — partly to keep this simple,
 * partly because the Voyage embeddings call is rate-limited per account, so
 * firing several ingests in parallel would just trip 429s faster. A failure
 * on one file (bad extension, Blob error, ingest error) must never abort the
 * rest of the batch or throw out of the action — that's what turned a single
 * bad upload into a full page crash before, so every per-file step is wrapped
 * in its own try/catch.
 */
export async function uploadDocument(formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();
  const files = formData.getAll("file").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    throw new Error("No files found in the form");
  }

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".md")) {
      // Skip unsupported files instead of aborting the whole batch — the rest
      // of the selected .md files should still upload.
      continue;
    }

    try {
      const blob = await put(`documents/${Date.now()}-${file.name}`, file, {
        access: "public",
        addRandomSuffix: true,
      });

      const [doc] = await db
        .insert(document)
        .values({
          workspaceId,
          filename: file.name,
          format: "md",
          blobUrl: blob.url,
          status: "processing",
        })
        .returning();

      try {
        await ingestMarkdownDocument(doc.id);
      } catch {
        // The document status is already marked as error inside ingestMarkdownDocument —
        // here we just keep this file from failing the rest of the batch.
      }
    } catch (err) {
      // Blob upload or the initial DB insert failed for this particular file
      // (e.g. Blob store misconfigured, DB unreachable) — log and move on to
      // the next file rather than failing the entire server action.
      console.error(`Failed to upload "${file.name}":`, err);
    }
  }

  revalidatePath("/documents");
}

export async function reingestDocument(documentId: string) {
  await ingestMarkdownDocument(documentId).catch(() => {});
  revalidatePath("/documents");
}

export async function deleteDocument(documentId: string) {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (doc) {
    await del(doc.blobUrl).catch(() => {});
    await db.delete(document).where(eq(document.id, documentId));
  }
  revalidatePath("/documents");
}
