import Link from "next/link";
import { db } from "@/db";
import { document, run, featureWorkflow } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { TOOLS } from "@/lib/tools/registry";
import { SetupNotice } from "@/components/setup-notice";

// Data is always live (DB/session) — do not cache statically.
export const dynamic = "force-dynamic";

async function loadOverviewData() {
  const workspaceId = await getCurrentWorkspaceId();

  const [docCounts] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      ready: sql<number>`count(*) filter (where ${document.status} = 'ready')`.mapWith(Number),
    })
    .from(document)
    .where(eq(document.workspaceId, workspaceId));

  const inProgressFeatures = await db
    .select()
    .from(featureWorkflow)
    .where(eq(featureWorkflow.workspaceId, workspaceId))
    .orderBy(sql`${featureWorkflow.updatedAt} desc`)
    .limit(5);

  const recentRuns = await db
    .select()
    .from(run)
    .where(eq(run.workspaceId, workspaceId))
    .orderBy(sql`${run.createdAt} desc`)
    .limit(5);

  return { docCounts, inProgressFeatures, recentRuns };
}

export default async function OverviewPage() {
  let data: Awaited<ReturnType<typeof loadOverviewData>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadOverviewData();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { docCounts, inProgressFeatures, recentRuns } = data;

  return (
    <div className="flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-neutral-500">Project context, history, and tools — all on one screen.</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-400">Documents</div>
          <div className="mt-1 text-2xl font-semibold">
            {docCounts?.ready ?? 0}/{docCounts?.total ?? 0}
          </div>
          <div className="text-xs text-neutral-400">ready / uploaded</div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-400">Features in progress</div>
          <div className="mt-1 text-2xl font-semibold">{inProgressFeatures.length}</div>
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="text-xs uppercase tracking-wide text-neutral-400">Tools</div>
          <div className="mt-1 text-2xl font-semibold">{TOOLS.length}</div>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Unfinished features</h2>
        {inProgressFeatures.length === 0 ? (
          <p className="text-sm text-neutral-400">
            Nothing here yet. Start a feature from any tool — progress will show up here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {inProgressFeatures.map((f) => (
              <li key={f.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{f.name}</span>
                  <span className="text-xs text-neutral-400">{f.currentStage}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Recent runs</h2>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-neutral-400">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentRuns.map((r) => (
              <li key={r.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{r.toolKey}</span>
                  <span className="text-xs text-neutral-400">
                    {r.inputTokens + r.outputTokens} tokens · ${Number(r.costEstimateUsd).toFixed(4)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-600 mb-2">Tools</h2>
        <div className="grid grid-cols-2 gap-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.key}
              href={`/tools/${tool.key}`}
              className="rounded-lg border border-neutral-200 bg-white p-4 hover:border-neutral-300"
            >
              <div className="font-medium">{tool.name}</div>
              <div className="mt-1 text-sm text-neutral-500">{tool.description}</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
