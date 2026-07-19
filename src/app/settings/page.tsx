import { db } from "@/db";
import { toolSettings, workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getSecretsStatus } from "@/lib/session";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "@/lib/models";
import { TOOLS } from "@/lib/tools/registry";
import { SetupNotice } from "@/components/setup-notice";
import { saveGeneralSettings, clearSecrets, saveToolModel } from "./actions";

export const dynamic = "force-dynamic";

async function loadSettingsData() {
  const workspaceId = await getDefaultWorkspaceId();

  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const secrets = await getSecretsStatus();
  const perToolSettings = await db.select().from(toolSettings).where(eq(toolSettings.workspaceId, workspaceId));

  return { ws, secrets, settingsByTool: new Map(perToolSettings.map((s) => [s.toolKey, s])) };
}

export default async function SettingsPage() {
  let data: Awaited<ReturnType<typeof loadSettingsData>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadSettingsData();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { ws, secrets, settingsByTool } = data;

  return (
      <div className="flex flex-col gap-10 max-w-3xl">
        <div>
          <h1 className="text-2xl font-semibold">Настройки</h1>
          <p className="mt-1 text-neutral-500">
            URL-ы сохраняются постоянно. Токены — только на время браузерной сессии, в БД не пишутся.
          </p>
        </div>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">GitLab и LLM-провайдер</h2>

          <form action={saveGeneralSettings} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600">GitLab URL</span>
                <input
                  name="gitlabUrl"
                  defaultValue={ws?.gitlabUrl ?? ""}
                  placeholder="https://gitlab.example.com"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600">
                  GitLab personal access token{" "}
                  {secrets.hasGitlabToken && (
                    <span className="text-emerald-600">(введён в этой сессии)</span>
                  )}
                </span>
                <input
                  type="password"
                  name="gitlabToken"
                  placeholder={secrets.hasGitlabToken ? "••••••••" : "не задан"}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600">
                  LLM provider URL <span className="text-neutral-400">(пусто = Anthropic по умолчанию)</span>
                </span>
                <input
                  name="llmProviderUrl"
                  defaultValue={ws?.defaultLlmProviderUrl ?? ""}
                  placeholder="https://api.anthropic.com"
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600">
                  LLM provider token{" "}
                  {secrets.hasLlmProviderToken && (
                    <span className="text-emerald-600">(введён в этой сессии)</span>
                  )}
                </span>
                <input
                  type="password"
                  name="llmProviderToken"
                  placeholder={secrets.hasLlmProviderToken ? "••••••••" : "не задан"}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
              >
                Сохранить
              </button>
              <span className="text-xs text-neutral-400">
                Пустое поле токена не затирает уже введённый в этой сессии
              </span>
            </div>
          </form>

          <form action={clearSecrets} className="mt-3">
            <button type="submit" className="text-xs text-red-600 hover:underline">
              Забыть все токены сейчас
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">Модели по инструментам</h2>
          <div className="flex flex-col divide-y divide-neutral-100">
            {TOOLS.map((tool) => {
              const current = settingsByTool.get(tool.key);
              const saveWithKey = saveToolModel.bind(null, tool.key);
              return (
                <form
                  key={tool.key}
                  action={saveWithKey}
                  className="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
                >
                  <div className="w-48 shrink-0 text-sm font-medium">{tool.name}</div>
                  <select
                    name="model"
                    defaultValue={current?.model ?? DEFAULT_MODEL_ID}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
                  >
                    {AVAILABLE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <input
                    name="providerBaseUrl"
                    defaultValue={current?.providerBaseUrl ?? ""}
                    placeholder="кастомный provider URL (необязательно)"
                    className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                  >
                    Сохранить
                  </button>
                </form>
              );
            })}
          </div>
        </section>
      </div>
  );
}
