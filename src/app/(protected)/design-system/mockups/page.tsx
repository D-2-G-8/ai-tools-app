import Link from "next/link";
import { db } from "@/db";
import { mockup } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { mockupStatusClass } from "./shared";
import { uploadMockup, deleteMockup } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function loadMockups() {
  const workspaceId = await getCurrentWorkspaceId();
  return db
    .select()
    .from(mockup)
    .where(eq(mockup.workspaceId, workspaceId))
    .orderBy(sql`${mockup.createdAt} desc`);
}

export default async function MockupsPage() {
  let mockups: Awaited<ReturnType<typeof loadMockups>> | null = null;
  let loadError: unknown = null;
  try {
    mockups = await loadMockups();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !mockups) {
    return <SetupNotice error={loadError} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-4">Upload .html mockups</h2>
        <form action={uploadMockup} encType="multipart/form-data" className="flex items-center gap-3">
          <input type="file" name="file" accept=".html,text/html" required multiple className="text-sm" />
          <button
            type="submit"
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            Upload
          </button>
        </form>
        <p className="mt-2 text-xs text-neutral-400">
          A mockup must be a self-contained .html page — tokens and component CSS/JS inlined, no external
          asset references — so it renders correctly straight out of Blob storage.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Mockups ({mockups.length})</h2>
        {mockups.length === 0 ? (
          <p className="text-sm text-neutral-400">Nothing uploaded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {mockups.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{m.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${mockupStatusClass[m.status]}`}>
                      {m.status}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-400">
                    {m.filename}
                    {m.status === "error" && m.errorMessage ? ` · ${m.errorMessage}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Link href={`/design-system/mockups/${m.id}`} className="text-xs text-neutral-600 hover:underline">
                    View
                  </Link>
                  <Link
                    href={`/design-system/mockups/${m.id}/edit`}
                    className="text-xs text-neutral-600 hover:underline"
                  >
                    Edit
                  </Link>
                  <form action={deleteMockup.bind(null, m.id)}>
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
