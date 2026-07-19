import Link from "next/link";
import { db } from "@/db";
import { document, user } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { DocumentsQA } from "@/components/documents-qa";
import { statusLabel, statusClass } from "./shared";
import { uploadDocument, reingestDocument, deleteDocument } from "./actions";

export const dynamic = "force-dynamic";
// Uploading several files in one request runs their ingests sequentially in
// the same server action — give it more headroom than the default so a
// multi-file batch doesn't get killed mid-way through.
export const maxDuration = 60;

async function loadDocuments() {
  const workspaceId = await getCurrentWorkspaceId();
  return db
    .select({ doc: document, creatorName: user.name, creatorEmail: user.email })
    .from(document)
    .leftJoin(user, eq(document.createdByUserId, user.id))
    .where(eq(document.workspaceId, workspaceId))
    .orderBy(sql`${document.createdAt} desc`);
}

export default async function DocumentsPage() {
  let docs: Awaited<ReturnType<typeof loadDocuments>> | null = null;
  let loadError: unknown = null;
  try {
    docs = await loadDocuments();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !docs) {
    return <SetupNotice error={loadError} />;
  }

  return (
      <div className="flex flex-col gap-8 max-w-4xl">
        <div>
          <h1 className="text-2xl font-semibold">Documents</h1>
          <p className="mt-1 text-neutral-500">
            Project context for all tools. To start, only .md files are supported —
            see PLAN.md for more on parsing and chunking.
          </p>
        </div>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">Upload .md files</h2>
          <form action={uploadDocument} encType="multipart/form-data" className="flex items-center gap-3">
            <input
              type="file"
              name="file"
              accept=".md,text/markdown"
              required
              multiple
              className="text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Upload and process
            </button>
          </form>
          <p className="mt-2 text-xs text-neutral-400">
            You can select multiple .md files at once — they&apos;re uploaded and processed one by one.
          </p>
        </section>

        <DocumentsQA />

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Uploaded documents ({docs.length})</h2>
          {docs.length === 0 ? (
            <p className="text-sm text-neutral-400">Nothing uploaded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.map(({ doc, creatorName, creatorEmail }) => (
                <li
                  key={doc.id}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{doc.title ?? doc.filename}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${statusClass[doc.status]}`}>
                        {statusLabel[doc.status] ?? doc.status}
                      </span>
                    </div>
                    <div className="text-xs text-neutral-400">
                      {doc.filename} · {doc.chunkCount} chunks
                      {(creatorName || creatorEmail) && ` · by ${creatorName ?? creatorEmail}`}
                      {doc.status === "error" && doc.errorMessage ? ` · ${doc.errorMessage}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link href={`/documents/${doc.id}`} className="text-xs text-neutral-600 hover:underline">
                      View
                    </Link>
                    <Link href={`/documents/${doc.id}/edit`} className="text-xs text-neutral-600 hover:underline">
                      Edit
                    </Link>
                    <a href={`/documents/${doc.id}/download`} className="text-xs text-neutral-600 hover:underline">
                      Download
                    </a>
                    {doc.status === "error" && (
                      <form action={reingestDocument.bind(null, doc.id)}>
                        <button type="submit" className="text-xs text-neutral-600 hover:underline">
                          Retry processing
                        </button>
                      </form>
                    )}
                    <form action={deleteDocument.bind(null, doc.id)}>
                      <button type="submit" className="text-xs text-red-600 hover:underline">
                        Delete
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
  );
}
