import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDocumentForWorkspace, loadDocumentContent } from "../../shared";
import { updateDocumentContent } from "../../actions";

export const dynamic = "force-dynamic";

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
        <form action={updateDocumentContent.bind(null, doc.id)} className="flex flex-col gap-3">
          <textarea
            name="content"
            defaultValue={content}
            rows={30}
            required
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-200 bg-white p-4 font-mono text-sm text-neutral-800"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Save and reprocess
            </button>
            <Link href={`/documents/${doc.id}`} className="text-sm text-neutral-500 hover:underline">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
