import { db } from "@/db";
import { document, documentChunk } from "@/db/schema";
import { eq } from "drizzle-orm";
import { chunkMarkdown, parseMarkdown } from "./markdown";
import { embedTexts } from "./embed";

/**
 * Ingest of a single .md document: download from Blob -> parse -> chunk by
 * headings -> get embeddings -> write into document_chunk.
 *
 * MVP: called synchronously right after the file upload (see
 * app/documents/actions.ts). For large batches of documents it should be moved
 * into a background job (Inngest) — see PLAN.md, section 2 (stack).
 */
export async function ingestMarkdownDocument(documentId: string): Promise<void> {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  try {
    const res = await fetch(doc.blobUrl);
    if (!res.ok) throw new Error(`Failed to download the file from Blob (${res.status})`);
    const raw = await res.text();

    const { title } = parseMarkdown(raw);
    const chunks = chunkMarkdown(raw);

    if (chunks.length === 0) {
      await db
        .update(document)
        .set({ status: "error", errorMessage: "Document is empty after parsing", updatedAt: new Date() })
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

/**
 * Vector search for relevant chunks to build context (RAG). Joins in the
 * parent document's filename — callers that only destructure headingPath /
 * content (the original shape) are unaffected; callers that want a citeable
 * source (e.g. the Documents Q&A feature) can read `documentFilename` too.
 */
export async function searchRelevantChunks(workspaceId: string, queryEmbedding: number[], limit = 8) {
  const { sql } = await import("drizzle-orm");
  return db.execute(sql`
    SELECT dc.id, dc.document_id as "documentId", dc.heading_path as "headingPath", dc.content,
           d.filename as "documentFilename",
           1 - (dc.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) AS similarity
    FROM document_chunk dc
    JOIN document d ON d.id = dc.document_id
    WHERE dc.workspace_id = ${workspaceId} AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${JSON.stringify(queryEmbedding)}::vector
    LIMIT ${limit}
  `);
}
