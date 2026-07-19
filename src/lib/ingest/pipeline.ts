import { db } from "@/db";
import { document, documentChunk } from "@/db/schema";
import { eq } from "drizzle-orm";
import { chunkMarkdown, parseMarkdown } from "./markdown";
import { embedTexts } from "./embed";

/**
 * Инжест одного .md документа: скачать из Blob -> распарсить -> начанковать
 * по заголовкам -> получить эмбеддинги -> записать в document_chunk.
 *
 * MVP: вызывается синхронно сразу после загрузки файла (см.
 * app/documents/actions.ts). Для больших пачек документов стоит вынести в
 * фоновую задачу (Inngest) — см. PLAN.md, раздел 2 (стек).
 */
export async function ingestMarkdownDocument(documentId: string): Promise<void> {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new Error(`Документ ${documentId} не найден`);

  try {
    const res = await fetch(doc.blobUrl);
    if (!res.ok) throw new Error(`Не удалось скачать файл из Blob (${res.status})`);
    const raw = await res.text();

    const { title } = parseMarkdown(raw);
    const chunks = chunkMarkdown(raw);

    if (chunks.length === 0) {
      await db
        .update(document)
        .set({ status: "error", errorMessage: "Документ пустой после парсинга", updatedAt: new Date() })
        .where(eq(document.id, documentId));
      return;
    }

    const embeddings = await embedTexts(chunks.map((c) => c.content));

    await db.transaction(async (tx) => {
      await tx.delete(documentChunk).where(eq(documentChunk.documentId, documentId));
      await tx.insert(documentChunk).values(
        chunks.map((c, i) => ({
          workspaceId: doc.workspaceId,
          documentId: doc.id,
          chunkIndex: c.chunkIndex,
          headingPath: c.headingPath,
          content: c.content,
          embedding: embeddings[i],
        })),
      );
      await tx
        .update(document)
        .set({
          status: "ready",
          title: title ?? doc.filename,
          chunkCount: chunks.length,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(document.id, documentId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(document)
      .set({ status: "error", errorMessage: message, updatedAt: new Date() })
      .where(eq(document.id, documentId));
    throw err;
  }
}

/** Векторный поиск релевантных чанков для контекста (RAG). */
export async function searchRelevantChunks(workspaceId: string, queryEmbedding: number[], limit = 8) {
  const { sql } = await import("drizzle-orm");
  return db.execute(sql`
    SELECT id, document_id as "documentId", heading_path as "headingPath", content,
           1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) AS similarity
    FROM document_chunk
    WHERE workspace_id = ${workspaceId} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
    LIMIT ${limit}
  `);
}
