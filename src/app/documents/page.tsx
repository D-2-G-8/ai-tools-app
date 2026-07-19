import { db } from "@/db";
import { document } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { uploadDocument, reingestDocument, deleteDocument } from "./actions";

export const dynamic = "force-dynamic";

const statusLabel: Record<string, string> = {
  processing: "обрабатывается",
  ready: "готов",
  error: "ошибка",
};

const statusClass: Record<string, string> = {
  processing: "bg-amber-100 text-amber-700",
  ready: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
};

async function loadDocuments() {
  const workspaceId = await getDefaultWorkspaceId();
  return db
    .select()
    .from(document)
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
          <h1 className="text-2xl font-semibold">Документы</h1>
          <p className="mt-1 text-neutral-500">
            Контекст проекта для всех инструментов. На старте поддерживаются только .md файлы —
            подробнее про парсинг и чанкование см. PLAN.md.
          </p>
        </div>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">Загрузить .md файл</h2>
          <form action={uploadDocument} encType="multipart/form-data" className="flex items-center gap-3">
            <input
              type="file"
              name="file"
              accept=".md,text/markdown"
              required
              className="text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Загрузить и обработать
            </button>
          </form>
        </section>

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Загруженные документы ({docs.length})</h2>
          {docs.length === 0 ? (
            <p className="text-sm text-neutral-400">Пока ничего не загружено.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {docs.map((doc) => (
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
                      {doc.filename} · {doc.chunkCount} чанков
                      {doc.status === "error" && doc.errorMessage ? ` · ${doc.errorMessage}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {doc.status === "error" && (
                      <form action={reingestDocument.bind(null, doc.id)}>
                        <button type="submit" className="text-xs text-neutral-600 hover:underline">
                          Повторить обработку
                        </button>
                      </form>
                    )}
                    <form action={deleteDocument.bind(null, doc.id)}>
                      <button type="submit" className="text-xs text-red-600 hover:underline">
                        Удалить
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
