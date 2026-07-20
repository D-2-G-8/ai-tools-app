import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getFigmaConnectionStatus } from "@/lib/session";
import { SetupNotice } from "@/components/setup-notice";
import { saveDesignSettings, disconnectFigma } from "./actions";
import { confirmAndMergePendingPr } from "./codegen-actions";
import {
  clearUnsyncedComponents,
  clearCodeSyncedComponents,
  clearUnsyncedTokens,
  clearCodeSyncedTokens,
  reconcileWithRepo,
} from "./cleanup-actions";
import { FigmaSyncButton } from "./figma-sync-button";
import { DesignSystemCodegenPanel } from "./design-system-codegen-panel";
import { ResyncTokensButton } from "./resync-tokens-button";
import { ResyncComponentsButton } from "./resync-components-button";
import { ClearAllButton } from "../clear-all-button";
import { loadComponentSlugsForWorkspace, loadCleanupCounts } from "@/lib/design-system-codegen/data";

export const dynamic = "force-dynamic";
// Note: the actual Figma sync (previously a slow Server Action here, hence
// a maxDuration bump) now streams from src/app/api/figma/sync/route.ts,
// which carries its own maxDuration -- this page's remaining actions
// (save settings, disconnect) are fast, so no bump needed here.

const STACK_OPTIONS = [
  { value: "react-scss", label: "React + SCSS" },
  { value: "react-css-modules", label: "React + CSS Modules (.module.scss)" },
  { value: "none", label: "No component code generation yet" },
];

async function loadSettingsData() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const figma = await getFigmaConnectionStatus();
  const components = await loadComponentSlugsForWorkspace(workspaceId);
  const cleanupCounts = await loadCleanupCounts(workspaceId);
  return { ws, figma, components, cleanupCounts };
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

export default async function DesignSettingsPage({
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

  const { ws, figma, components, cleanupCounts } = data;
  const canSync = figma.connected && Boolean(ws.figmaFileKey);
  const codeSyncEnabled = ws.designComponentStack !== "none";

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <FigmaResultBanner sp={sp} />

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
        <h2 className="text-sm font-medium text-neutral-700 mb-1">Figma source</h2>
        <p className="mb-4 text-xs text-neutral-400">
          The file key used when syncing tokens and components from Figma -- the part of the file URL after
          <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5">/file/</code>
          or <code className="mx-1 rounded bg-neutral-100 px-1 py-0.5">/design/</code>.
        </p>
        <form action={saveDesignSettings} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Figma file key</span>
            <input
              name="figmaFileKey"
              defaultValue={ws.figmaFileKey ?? ""}
              placeholder="e.g. OcaHeBKMqemoZZt2C5z0wd"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-mono"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Component code stack</span>
            <select
              name="componentStack"
              defaultValue={ws.designComponentStack}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            >
              {STACK_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            Save
          </button>
        </form>

        <div className="mt-4 flex flex-col gap-3 border-t border-neutral-100 pt-4">
          {canSync ? (
            <>
              <FigmaSyncButton />
              <ResyncTokensButton />
              <ResyncComponentsButton />
            </>
          ) : (
            <p className="text-xs text-neutral-400">
              {figma.connected
                ? "Set a Figma file key above, then sync."
                : "Connect Figma above, and set a file key, then sync."}
            </p>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">Design system code sync</h2>
        <p className="mb-4 text-xs text-neutral-400">
          Generates real React + CSS Modules code for each synced component (and a tokens.css from the
          tokens above) and opens a pull request in the separate{" "}
          <a
            href={`https://github.com/${process.env.GITHUB_DESIGN_SYSTEM_REPO ?? "D-2-G-8/design-system"}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            design-system
          </a>{" "}
          repo -- nothing merges automatically, review the PR&apos;s CI status and confirm below.
        </p>

        {ws.designSystemPendingPrUrl && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>
              A pull request is open --{" "}
              <a href={ws.designSystemPendingPrUrl} target="_blank" rel="noreferrer" className="underline">
                review it
              </a>
              , then confirm once its checks look right.
            </span>
            <form action={confirmAndMergePendingPr}>
              <button
                type="submit"
                className="shrink-0 rounded-md bg-amber-900 px-3 py-1 text-xs text-white hover:bg-amber-800"
              >
                Confirm &amp; merge
              </button>
            </form>
          </div>
        )}

        {codeSyncEnabled ? (
          <DesignSystemCodegenPanel components={components} />
        ) : (
          <p className="text-xs text-neutral-400">
            Set &quot;Component code stack&quot; above to something other than &quot;No component code
            generation yet&quot; to enable this.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">Cleanup</h2>
        <p className="mb-4 text-xs text-neutral-400">
          Bulk removal for stale/duplicate rows -- for when a Figma file has piled up enough garbage that
          sorting it out one at a time (Delete on each component/token) isn&apos;t worth it. Metadata-only
          rows are a plain delete; rows already generated into the design-system repo also need their code
          removed there, so those open/update a pull request instead of deleting anything immediately -- same
          review-before-merge as the rest of code sync above.
        </p>

        <div className="mb-4 border-b border-neutral-100 pb-4">
          <h3 className="mb-1 text-xs font-medium text-neutral-600">Repo state</h3>
          <p className="mb-2 text-xs text-neutral-400">
            &quot;Generated&quot; is tracked in the database. If a PR/branch was deleted in the design-system repo
            without merging, those components aren&apos;t actually there anymore -- reconcile checks the real repo
            and resets any that are gone (and clears a dangling pending PR), so the rest of code sync stays honest.
          </p>
          <ClearAllButton
            action={reconcileWithRepo}
            label="Reconcile with repo"
            confirmText="Check the design-system repo and reset any components that aren't actually there (e.g. a deleted PR branch)? Safe -- only fixes DB drift."
          />
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 text-xs font-medium text-neutral-600">Components</h3>
            <div className="flex flex-wrap items-center gap-3">
              {cleanupCounts.componentsUnsynced > 0 ? (
                <ClearAllButton
                  action={clearUnsyncedComponents}
                  label={`Clear synced-only components (${cleanupCounts.componentsUnsynced})`}
                  confirmText={`Delete ${cleanupCounts.componentsUnsynced} component(s) that were never generated into code? A sync afterwards will repopulate whatever's still in the current Figma file.`}
                />
              ) : (
                <span className="text-xs text-neutral-400">No synced-only components.</span>
              )}
              {cleanupCounts.componentsCodeSynced > 0 && (
                <ClearAllButton
                  action={clearCodeSyncedComponents}
                  label={`Remove components from repo (${cleanupCounts.componentsCodeSynced})`}
                  confirmText={`Remove ${cleanupCounts.componentsCodeSynced} component(s) already generated into the design-system repo? This opens/updates a pull request deleting their files there -- review & confirm it below once ready, same as generation.`}
                />
              )}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-medium text-neutral-600">Tokens</h3>
            <div className="flex flex-wrap items-center gap-3">
              {cleanupCounts.tokensUnsynced > 0 ? (
                <ClearAllButton
                  action={clearUnsyncedTokens}
                  label={`Clear synced-only tokens (${cleanupCounts.tokensUnsynced})`}
                  confirmText={`Delete ${cleanupCounts.tokensUnsynced} token(s) that were never generated into code? A sync afterwards will repopulate whatever's still in the current Figma file.`}
                />
              ) : (
                <span className="text-xs text-neutral-400">No synced-only tokens.</span>
              )}
              {cleanupCounts.tokensCodeSynced > 0 && (
                <ClearAllButton
                  action={clearCodeSyncedTokens}
                  label={`Remove tokens from repo (${cleanupCounts.tokensCodeSynced})`}
                  confirmText={`Remove ${cleanupCounts.tokensCodeSynced} token(s) already generated into tokens.css in the design-system repo? This opens/updates a pull request with a regenerated tokens.css that drops them -- review & confirm it below once ready.`}
                />
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
