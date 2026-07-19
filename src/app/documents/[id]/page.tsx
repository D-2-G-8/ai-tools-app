import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { document } from "@/db/schema";
import { getDefaultWorkspaceId } from "@/db/workspace";

export const dynamic = "force-dynamic";

const statusLabel: Record<string, string> = {
  processing: "processing",
  ready: "ready",
  error: "error",
};

const statusClass: Record<string, string> = {
  processing: "bg-amber-100 text-amber-700",
  ready: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
};

async function loadDocument(id: string) {
  const workspaceId = await getDefaultWorkspaceId();
  const [doc] = await db
    .select()
    .from(document)
    .where(and(eq(document.id, id), eq(document.workspaceId, workspaceId)))
    .limit(1);
  return doc;
}

/**
 * Fetches the raw markdown straight from Blob for display. This mirrors the
 * download step in ingestMarkdownDocument (lib/ingest/pipeline.ts) but is
 * intentionally kept separate — this is a read-only view for a human, not
 * part of the ingest pipeline, and must never throw (a bad/expired blob URL
 * should render an inline error, not crash the page).
 */
async function loadContent(blobUrl: string): Promise<{ content?: string; error?: string }> {
  try {
    const res = await fetch(blobUrl, { cache: "no-store" });
    if (!res.ok) return { error: `Failed to download the file (${res.status})` };
    return { content: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function DocumentViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = await loadDocument(id);
  if (!doc) notFound();

  const { content, error: contentError } = await loadContent(doc.blobUrl);

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <div>
        <Link href="/documents" className="text-sm text-neutral-500 hover:underline">
          ← Back to documents
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold break-words">{doc.title ?? doc.filename}</h1>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${statusClass[doc.status]}`}>
            {statusLabel[doc.status] ?? doc.status}
          </span>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          {doc.filename} · {doc.chunkCount} chunks · uploaded {doc.createdAt.toLocaleString()}
        </p>
        {doc.status === "error" && doc.errorMessage && (
          <p className="mt-1 text-sm text-red-600">{doc.errorMessage}</p>
        )}
        <a
          href={doc.blobUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-xs text-neutral-400 hover:underline"
        >
          Open original file
        </a>
      </div>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        {contentError ? (
          <p className="text-sm text-red-600">Couldn&apos;t load the file content: {contentError}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-neutral-800">
            {content}
          </pre>
        )}
      </section>
    </div>
  );
}
