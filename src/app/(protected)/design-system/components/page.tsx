import Link from "next/link";
import { db } from "@/db";
import { designComponent, workspace } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { ComponentsGrid, type ComponentListItem } from "./components-grid";

export const dynamic = "force-dynamic";

async function loadComponents() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  // Icons get their own tab (design-system/icons) -- there are commonly
  // hundreds of them, and a full card per icon here would drown out real
  // components. See src/lib/figma/sync.ts's isLikelyIconName for how a
  // row ends up flagged isIcon.
  const components = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.isIcon, false)))
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

  // Pre-formatted server-side (not passed as a raw Date) so the grid below
  // can stay a plain, easily-serializable client component.
  const items: ComponentListItem[] = components.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    variantsCount: c.variants.length,
    statesCount: c.states.length,
    lastSyncedLabel: formatRelativeTime(c.updatedAt),
    codeSyncStatus: c.codeSyncStatus,
  }));

  // Bulk "clear all" lives in Settings now (see settings/cleanup-actions.ts),
  // split there between metadata-only rows and rows already committed to the
  // design-system repo.
  return <ComponentsGrid components={items} />;
}
