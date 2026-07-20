import { db } from "@/db";
import { designComponent, workspace } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { IconsGrid, type IconListItem } from "./icons-grid";

export const dynamic = "force-dynamic";

async function loadIcons() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  // Split out of the main Components list -- see src/lib/figma/sync.ts's
  // isLikelyIconName for how a synced row ends up flagged isIcon.
  const icons = await db
    .select({ slug: designComponent.slug, name: designComponent.name })
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.isIcon, true)))
    .orderBy(designComponent.name);
  return { ws, icons };
}

export default async function DesignIconsPage() {
  let data: Awaited<ReturnType<typeof loadIcons>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadIcons();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { ws, icons } = data;

  if (icons.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <p className="text-sm text-neutral-600">No icons synced yet.</p>
        <p className="mt-1 text-sm text-neutral-400">
          {ws?.figmaFileKey
            ? "Sync from the Settings tab -- entries recognized as icons land here automatically."
            : "Configure a Figma file on the Settings tab, then sync."}
        </p>
      </div>
    );
  }

  const items: IconListItem[] = icons;
  return <IconsGrid icons={items} />;
}
