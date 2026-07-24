import { db } from "@/db";
import { toolSettings, workspace } from "@/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { getSecretsStatus, getFigmaConnectionStatus } from "@/lib/session";
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "@/lib/models";
import { TOOLS } from "@/lib/tools/registry";
import { SetupNotice } from "@/components/setup-notice";
import { saveGeneralSettings, clearSecrets, saveToolModel, disconnectFigma } from "./actions";

export const dynamic = "force-dynamic";

async function loadSettingsData() {
  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();

  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const secrets = await getSecretsStatus();
  const figma = await getFigmaConnectionStatus();

  // Model settings are per-user (see src/lib/tools/model-settings.ts) --
  // fetch the signed-in user's own rows plus any legacy company-wide row
  // (userId IS NULL) to fall back to as the pre-filled default when they
  // haven't picked a model of their own yet.
  const rows = currentUser
    ? await db
        .select()
        .from(toolSettings)
        .where(
          and(
            eq(toolSettings.workspaceId, workspaceId),
            or(eq(toolSettings.userId, currentUser.id), isNull(toolSettings.userId)),
          ),
        )
    : [];

  const personalByTool = new Map(rows.filter((r) => r.userId === currentUser?.id).map((s) => [s.toolKey, s]));
  const legacyByTool = new Map(rows.filter((r) => r.userId === null).map((s) => [s.toolKey, s]));

  return { ws, secrets, figma, personalByTool, legacyByTool };
}

function FigmaResultBanner({
  sp,
}: {
  sp: { [key: string]: string | string[] | undefined };
}) {
  const status = typeof sp.figma === "string" ? sp.figma : undefined;
  if (!status) return null;

  if (status === "connected") {
    return (
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Figma connected.</p>
    );
  }
  if (status === "disconnected") {
    return <p className="rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-600">Figma disconnected.</p>;
  }
  if (status === "error") {
    const message = typeof sp.figmaMessage === "string" ? sp.figmaMessage : "Something went wrong.";
    return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>;
  }
  return null;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;

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

  const { ws, secrets, figma, personalByTool, legacyByTool } = data;

  return (
      <div className="flex flex-col gap-10 max-w-3xl">
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-1 text-neutral-500">
            URLs are stored permanently. Tokens live only for the browser session and are never written to the DB.
          </p>
        </div>

        <FigmaResultBanner sp={sp} />

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">GitLab and LLM provider</h2>

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
                    <span className="text-emerald-600">(entered in this session)</span>
                  )}
                </span>
                <input
                  type="password"
                  name="gitlabToken"
                  placeholder={secrets.hasGitlabToken ? "••••••••" : "not set"}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-neutral-600">
                GitLab project IDs for AI Review <span className="text-neutral-400">(comma-separated)</span>
              </span>
              <input
                name="gitlabProjectIds"
                defaultValue={ws?.gitlabProjectIds ?? ""}
                placeholder="123, group/subgroup/project"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
              />
            </label>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-neutral-600">
                  LLM provider URL <span className="text-neutral-400">(empty = Anthropic by default)</span>
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
                    <span className="text-emerald-600">(entered in this session)</span>
                  )}
                </span>
                <input
                  type="password"
                  name="llmProviderToken"
                  placeholder={secrets.hasLlmProviderToken ? "••••••••" : "not set"}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
                />
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
              >
                Save
              </button>
              <span className="text-xs text-neutral-400">
                Leaving the token field empty won&apos;t overwrite the one already entered this session
              </span>
            </div>
          </form>

          <form action={clearSecrets} className="mt-3">
            <button type="submit" className="text-xs text-red-600 hover:underline">
              Forget all tokens now
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-1">Figma account</h2>
          <p className="mb-4 text-xs text-neutral-400">
            Each person connects their own Figma account -- whichever login is convenient for them (personal,
            a work seat, whatever), independent of the Google account used to sign into this app. Nobody needs
            to standardize accounts across systems just to sync the design system.
          </p>

          {figma.connected ? (
            <div className="flex items-center gap-3">
              <span className="text-sm text-neutral-600">
                Connected{figma.figmaUserHandle ? ` as ${figma.figmaUserHandle}` : ""}
              </span>
              <form action={disconnectFigma}>
                <button type="submit" className="text-xs text-red-600 hover:underline">
                  Disconnect
                </button>
              </form>
            </div>
          ) : (
            <a
              href="/api/figma/oauth/start"
              className="inline-block rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Connect Figma
            </a>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-1">Your models per tool</h2>
          <p className="mb-4 text-xs text-neutral-400">
            Personal to you — each teammate can pick their own model per tool. Until you save one, a tool falls
            back to the company&apos;s previously-set default (if any), then to {DEFAULT_MODEL_ID}.
          </p>
          <div className="flex flex-col divide-y divide-neutral-100">
            {TOOLS.map((tool) => {
              const personal = personalByTool.get(tool.key);
              const legacy = legacyByTool.get(tool.key);
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
                    defaultValue={personal?.model ?? legacy?.model ?? DEFAULT_MODEL_ID}
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
                    defaultValue={personal?.providerBaseUrl ?? legacy?.providerBaseUrl ?? ""}
                    placeholder="custom provider URL (optional)"
                    className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
                  />
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                  >
                    Save
                  </button>
                </form>
              );
            })}
          </div>
        </section>
      </div>
  );
}
