import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDocumentForWorkspace, loadDocumentContent } from "../../shared";
import { DocumentEditForm } from "@/components/document-edit-form";

export const dynamic = "force-dynamic";
// Saving re-ingests the document, which can now include several sequential
// vision-model calls (one per embedded image, see lib/ingest/images.ts) on
// top of chunking/embedding -- give it the same headroom as the upload flow.
export const maxDuration = 60;

export default async function DocumentEditPage({
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
        <Link href={`/documents/${doc.id}`} className="text-sm text-neutral-500 hover:underline">
          ← Back to document
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold break-words">Edit {doc.filename}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Saving reprocesses the document — it&apos;s re-chunked and re-embedded, so search and
          project context pick up your changes right away.
        </p>
      </div>

      {contentError ? (
        <p className="text-sm text-red-600">Couldn&apos;t load the file content: {contentError}</p>
      ) : (
        <DocumentEditForm documentId={doc.id} initialContent={content ?? ""} />
      )}
    </div>
  );
}
