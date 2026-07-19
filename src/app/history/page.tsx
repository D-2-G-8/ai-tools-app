import Link from "next/link";
import { db } from "@/db";
import { run, featureWorkflow } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getTool } from "@/lib/tools/registry";
import { SetupNotice } from "@/components/setup-notice";

export const dynamic = "force-dynamic";

async function loadHistoryData() {
  const workspaceId = await getDefaultWorkspaceId();

  const features = await db
    .select()
    .from(featureWorkflow)
    .where(eq(featureWorkflow.workspaceId, workspaceId))
    .orderBy(sql`${featureWorkflow.updatedAt} desc`);

  const runs = await db
    .select()
    .from(run)
    .where(eq(run.workspaceId, workspaceId))
    .orderBy(sql`${run.createdAt} desc`)
    .limit(50);

  return { features, runs };
}

export default async function HistoryPage() {
  let data: Awaited<ReturnType<typeof loadHistoryData>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadHistoryData();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { features, runs } = data;

  return (
      <div className="flex flex-col gap-8 max-w-4xl">
        <div>
          <h1 className="text-2xl font-semibold">История</h1>
          <p className="mt-1 text-neutral-500">
            Фичи в работе (можно продолжить с той стадии, где остановились) и лог прогонов инструментов.
          </p>
        </div>

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Фичи</h2>
          {features.length === 0 ? (
            <p className="text-sm text-neutral-400">Пока ни одной фичи не начато.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {features.map((f) => {
                const stageTool = getTool(f.currentStage);
                return (
                  <li key={f.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-medium">{f.name}</div>
                        <div className="text-xs text-neutral-400">
                          статус: {f.status} · стадия: {stageTool?.name ?? f.currentStage}
                        </div>
                      </div>
                      {stageTool && (
                        <Link
                          href={`/tools/${stageTool.key}?feature=${f.id}`}
                          className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                        >
                          Продолжить
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium text-neutral-600 mb-2">Прогоны инструментов (последние 50)</h2>
          {runs.length === 0 ? (
            <p className="text-sm text-neutral-400">Прогонов ещё не было.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2 font-medium">Инструмент</th>
                  <th className="py-2 font-medium">Модель</th>
                  <th className="py-2 font-medium">Токены</th>
                  <th className="py-2 font-medium">Стоимость</th>
                  <th className="py-2 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="py-2">{getTool(r.toolKey)?.name ?? r.toolKey}</td>
                    <td className="py-2">{r.model}</td>
                    <td className="py-2">
                      {r.inputTokens} / {r.outputTokens}
                    </td>
                    <td className="py-2">${Number(r.costEstimateUsd).toFixed(4)}</td>
                    <td className="py-2">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
  );
}
