"use server";

import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { db } from "@/db";
import { document } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { ingestMarkdownDocument } from "@/lib/ingest/pipeline";

/**
 * MVP: только .md, серверная загрузка (через Server Action, файл в FormData).
 * Для файлов больше нескольких МБ стоит перейти на клиентскую загрузку
 * (@vercel/blob client upload) — см. README "Известные ограничения".
 */
export async function uploadDocument(formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new Error("Файл не найден в форме");
  }
  if (!file.name.toLowerCase().endsWith(".md")) {
    throw new Error("На этом этапе поддерживаются только .md файлы");
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
    // Статус документа уже помечен как error внутри ingestMarkdownDocument —
    // здесь просто не даём серверному экшену упасть с 500.
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
