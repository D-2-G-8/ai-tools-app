import Link from "next/link";
import { db } from "@/db";
import { designComponent, workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { DeleteComponentButton } from "./delete-component-button";

export const dynamic = "force-dynamic";

async function loadComponents() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const components = await db
    .select()
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId))
    .orderBy(designComponent.name);
  return { ws, components };
}

export default async function DesignComponentsPage() {
  let data: Awaited<ReturnType<typeof loadComponents>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadComponents();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { ws, components } = data;

  if (components.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <p className="text-sm text-neutral-600">No components synced yet.</p>
        <p className="mt-1 text-sm text-neutral-400">
          {ws?.figmaFileKey
            ? "A Figma file is configured — sync components from it on the Settings tab."
            : "Configure a Figma file on the Settings tab, then sync components from it."}
        </p>
        <Link
          href="/design-system/settings"
          className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Go to Settings
        </Link>
      </div>
    );
  }

  return (
    // Bulk "clear all" lives in Settings now (see settings/cleanup-actions.ts),
    // split there between metadata-only rows and rows already committed to the
    // design-system repo -- the distinction that matters for whether clearing
    // is a plain DB delete or also touches the repo (see DeleteComponentButton).
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {components.map((component) => (
        <li key={component.id} className="rounded-lg border border-neutral-200 bg-white p-4 text-sm hover:border-neutral-300">
          <Link href={`/design-system/components/${component.slug}`} className="block">
            <div className="font-medium">{component.name}</div>
            {component.description && (
              <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{component.description}</p>
            )}
            <div className="mt-2 text-xs text-neutral-400">
              {component.variants.length} variants · {component.states.length} states
            </div>
            {/* Last time metadata sync (full or targeted) confirmed this component still exists in
                Figma -- see delete-component-button.tsx's doc comment for why this matters before
                deleting: a row a RECENT sync just confirmed will simply come back on the next sync,
                while one with an old timestamp here wasn't found by the most recent sync and is safe
                to remove for good. */}
            <div className="mt-1 text-xs text-neutral-400">Last synced {formatRelativeTime(component.updatedAt)}</div>
          </Link>
          <div className="mt-2 flex items-center justify-between border-t border-neutral-100 pt-2">
            <span className="text-xs text-neutral-400">
              {component.codeSyncStatus === "committed" ? "In design-system repo" : "Metadata only"}
            </span>
            <DeleteComponentButton slug={component.slug} name={component.name} codeSyncStatus={component.codeSyncStatus} />
          </div>
        </li>
      ))}
    </ul>
  );
}
