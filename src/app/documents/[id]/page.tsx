import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDocumentForWorkspace, loadDocumentContent, statusLabel, statusClass } from "../shared";

export const dynamic = "force-dynamic";

export default async function DocumentViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = await loadDocumentForWorkspace(id);
  if (!doc) notFound();

  const { content, error: contentError } = await loadDocumentContent(doc.blobUrl);

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
        <div className="mt-1 flex items-center gap-3 text-xs text-neutral-400">
          <Link href={`/documents/${doc.id}/edit`} className="hover:underline">
            Edit
          </Link>
          <a href={doc.blobUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
            Open original file
          </a>
        </div>
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
