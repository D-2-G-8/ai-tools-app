import { notFound } from "next/navigation";
import { db } from "@/db";
import { run } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getTool } from "@/lib/tools/registry";
import { AVAILABLE_MODELS, estimateCostUsd } from "@/lib/models";
import { SetupNotice } from "@/components/setup-notice";

export const dynamic = "force-dynamic";

export default async function ToolStatsPage({
  params,
}: {
  params: Promise<{ toolKey: string }>;
}) {
  const { toolKey } = await params;
  const tool = getTool(toolKey);
  if (!tool) notFound();

  type StatsRow = {
    model: string;
    runs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    totalCostUsd: number;
    avgCostUsd: number;
  };
  const statsSelect = {
    model: run.model,
    runs: sql<number>`count(*)`.mapWith(Number),
    avgInputTokens: sql<number>`round(avg(${run.inputTokens}))`.mapWith(Number),
    avgOutputTokens: sql<number>`round(avg(${run.outputTokens}))`.mapWith(Number),
    totalCostUsd: sql<number>`coalesce(sum(${run.costEstimateUsd}), 0)`.mapWith(Number),
    avgCostUsd: sql<number>`coalesce(avg(${run.costEstimateUsd}), 0)`.mapWith(Number),
  };
  let byModel: StatsRow[] | null = null;
  let myByModel: StatsRow[] | null = null;
  let loadError: unknown = null;
  try {
    const workspaceId = await getCurrentWorkspaceId();
    const currentUser = await getCurrentUser();

    byModel = await db
      .select(statsSelect)
      .from(run)
      .where(and(eq(run.workspaceId, workspaceId), eq(run.toolKey, toolKey)))
      .groupBy(run.model);

    myByModel = currentUser
      ? await db
          .select(statsSelect)
          .from(run)
          .where(and(eq(run.workspaceId, workspaceId), eq(run.toolKey, toolKey), eq(run.userId, currentUser.id)))
          .groupBy(run.model)
      : [];
  } catch (err) {
    loadError = err;
  }

  if (loadError || !byModel || !myByModel) {
    return <SetupNotice error={loadError} />;
  }

  const hasHistory = byModel.length > 0;
  const hasMyHistory = myByModel.length > 0;

  function renderStatsTable(rows: StatsRow[]) {
    return (
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-neutral-500">
            <th className="py-2 font-medium">Model</th>
            <th className="py-2 font-medium">Runs</th>
            <th className="py-2 font-medium">Avg in/out tokens</th>
            <th className="py-2 font-medium">Avg cost</th>
            <th className="py-2 font-medium">Total spent</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model} className="border-b border-neutral-100">
              <td className="py-2">{row.model}</td>
              <td className="py-2">{row.runs}</td>
              <td className="py-2">
                {row.avgInputTokens} / {row.avgOutputTokens}
              </td>
              <td className="py-2">${row.avgCostUsd.toFixed(4)}</td>
              <td className="py-2">${row.totalCostUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
      <div className="flex flex-col gap-8">
        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Your usage</h2>
          {!hasMyHistory ? (
            <p className="text-sm text-neutral-400">
              No runs of your own yet — data will appear after your first run of this tool.
            </p>
          ) : (
            renderStatsTable(myByModel)
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Company total</h2>
          {!hasHistory ? (
            <p className="text-sm text-neutral-400">
              No runs yet — data will appear after the first run of this tool.
            </p>
          ) : (
            renderStatsTable(byModel)
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">
            Forward-looking estimate (based on model pricing)
          </h2>
          <p className="mb-3 text-xs text-neutral-400">
            Sample request: 20,000 input tokens (prompt + context) + 2,000 output.
            Real numbers for this tool will appear in the tab above after the first runs.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-neutral-500">
                <th className="py-2 font-medium">Model</th>
                <th className="py-2 font-medium">Price per 1M in/out</th>
                <th className="py-2 font-medium">Estimate per request</th>
              </tr>
            </thead>
            <tbody>
              {AVAILABLE_MODELS.map((m) => (
                <tr key={m.id} className="border-b border-neutral-100">
                  <td className="py-2">{m.label}</td>
                  <td className="py-2">
                    ${m.inputPricePerMTok} / ${m.outputPricePerMTok}
                  </td>
                  <td className="py-2">${estimateCostUsd(m.id, 20_000, 2_000).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
  );
}
