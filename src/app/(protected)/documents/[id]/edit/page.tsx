import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { loadDocumentForWorkspace, loadDocumentContent } from "../../shared";
import { acquireOrRenewEditLock } from "@/db/edit-lock";
import { DocumentEditForm } from "@/components/document-edit-form";
import { EditLockHeartbeat } from "@/components/edit-lock-heartbeat";
import { formatRelativeTime } from "@/lib/format-relative-time";

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

  // Only one person may edit a document at a time -- see src/db/edit-lock.ts.
  // This also acquires/renews the lock for the current user when it
  // succeeds, so simply reloading this page keeps an active edit session alive.
  const lockResult = await acquireOrRenewEditLock(doc.id);

  if (!lockResult.ok) {
    const [locker] = await db.select().from(user).where(eq(user.id, lockResult.lockedByUserId)).limit(1);
    const lockerLabel = locker?.name ?? locker?.email ?? "Someone else";

    return (
      <div className="flex flex-col gap-6 max-w-4xl">
        <div>
          <Link href={`/documents/${doc.id}`} className="text-sm text-neutral-500 hover:underline">
            ← Back to document
          </Link>
        </div>
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h1 className="text-lg font-semibold text-amber-900">This document is being edited</h1>
          <p className="mt-2 text-sm text-amber-800">
            <strong>{lockerLabel}</strong> is currently editing this document (last active{" "}
            {formatRelativeTime(lockResult.lockedAt)}). To avoid overwriting each other&apos;s changes, only
            one person can edit a document at a time.
          </p>
          <p className="mt-2 text-xs text-amber-700">
            The lock is released automatically a few minutes after they stop actively editing, or as soon as
            they save or cancel — reload this page to try again.
          </p>
        </section>
      </div>
    );
  }

  const { content, error: contentError } = await loadDocumentContent(doc.blobUrl);

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <EditLockHeartbeat documentId={doc.id} />
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
