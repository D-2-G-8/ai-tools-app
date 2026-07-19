"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { put, del } from "@vercel/blob";
import { db } from "@/db";
import { document } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
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
  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();
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
          createdByUserId: currentUser?.id,
          updatedByUserId: currentUser?.id,
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

/**
 * Saves edited markdown content from the document edit page: uploads it as a
 * new Blob, points the document row at it, deletes the old Blob, and
 * re-ingests (re-chunks + re-embeds) so RAG search and the Business
 * Requirements tool's project context stay in sync with the edit. Mirrors
 * the error-handling shape of uploadDocument/finalizeDocument — any failure
 * is caught and recorded on the document row rather than thrown, so a bad
 * edit can never crash the page.
 */
export async function updateDocumentContent(documentId: string, formData: FormData) {
  const content = String(formData.get("content") ?? "");
  const currentUser = await getCurrentUser();

  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) {
    redirect("/documents");
  }

  const previousBlobUrl = doc.blobUrl;

  try {
    const blob = await put(`documents/${Date.now()}-${doc.filename}`, content, {
      access: "public",
      addRandomSuffix: true,
    });

    await db
      .update(document)
      .set({
        blobUrl: blob.url,
        status: "processing",
        errorMessage: null,
        updatedAt: new Date(),
        updatedByUserId: currentUser?.id,
      })
      .where(eq(document.id, documentId));

    await del(previousBlobUrl).catch(() => {});

    try {
      await ingestMarkdownDocument(documentId);
    } catch {
      // Status is already marked "error" inside ingestMarkdownDocument.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(document)
      .set({ status: "error", errorMessage: message, updatedAt: new Date() })
      .where(eq(document.id, documentId));
  }

  revalidatePath("/documents");
  revalidatePath(`/documents/${documentId}`);
  redirect(`/documents/${documentId}`);
}
