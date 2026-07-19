"use server";

import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { db } from "@/db";
import { document } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { ingestMarkdownDocument } from "@/lib/ingest/pipeline";

/**
 * MVP: .md only, server-side upload (via Server Action, file in FormData).
 * For files larger than a few MB, switch to client-side upload
 * (@vercel/blob client upload) — see the README "Known limitations".
 */
export async function uploadDocument(formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new Error("File not found in the form");
  }
  if (!file.name.toLowerCase().endsWith(".md")) {
    throw new Error("Only .md files are supported at this stage");
  }

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

  revalidatePath("/documents");

  try {
    await ingestMarkdownDocument(doc.id);
  } catch {
    // The document status is already marked as error inside ingestMarkdownDocument —
    // here we just keep the server action from failing with a 500.
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
