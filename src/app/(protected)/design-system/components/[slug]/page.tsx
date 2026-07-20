import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { designComponent, workspace } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { figmaNodeUrl } from "@/lib/figma/links";
import { storybookDefaultStoryId } from "@/lib/design-system-codegen/component";
import { ResyncComponentButton } from "./resync-component-button";
import { DeleteComponentButton } from "../delete-component-button";

export const dynamic = "force-dynamic";

const CODE_SYNC_STATUS_LABEL: Record<string, string> = {
  never: "Not generated yet",
  pending: "Generating...",
  committed: "Committed",
  failed: "Last attempt failed",
};

const CODE_SYNC_STATUS_CLASS: Record<string, string> = {
  never: "text-neutral-400",
  pending: "text-neutral-600",
  committed: "text-emerald-600",
  failed: "text-red-600",
};

async function loadComponent(slug: string) {
  const workspaceId = await getCurrentWorkspaceId();
  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  if (!component) return { component: undefined, figmaFileKey: undefined };

  // Only needed to build the "open in Figma" links below -- a second,
  // cheap single-column select rather than widening the component query.
  const [ws] = await db
    .select({ figmaFileKey: workspace.figmaFileKey })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return { component, figmaFileKey: ws?.figmaFileKey ?? undefined };
}

export default async function DesignComponentDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { component, figmaFileKey } = await loadComponent(slug);
  if (!component) notFound();

  return (
    <div className="flex flex-col gap-6">
      <Link href="/design-system/components" className="text-sm text-neutral-500 hover:underline">
        ← Back to components
      </Link>

      <div>
        <h2 className="text-xl font-semibold">{component.name}</h2>
        {component.description && <p className="mt-1 text-neutral-600">{component.description}</p>}
        {/* See delete-component-button.tsx's doc comment: a component the most recent Figma sync just
            confirmed will simply come back on the next sync if deleted -- check this timestamp first. */}
        <p className="mt-1 text-xs text-neutral-400">Last synced {formatRelativeTime(component.updatedAt)}</p>
      </div>

      {component.variants.length > 0 && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">Variants</h3>
          <ul className="flex flex-col gap-2">
            {component.variants.map((variant, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{variant.name}</span>
                {variant.description && <span className="text-neutral-500"> — {variant.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {component.states.length > 0 && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h3 className="mb-3 text-sm font-medium text-neutral-700">States</h3>
          <ul className="flex flex-col gap-2">
            {component.states.map((state, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{state.name}</span>
                {state.description && <span className="text-neutral-500"> — {state.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {component.notes && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5">
          <h3 className="mb-2 text-sm font-medium text-amber-800">Notes</h3>
          <p className="text-sm text-amber-900">{component.notes}</p>
        </section>
      )}

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h3 className="mb-1 text-sm font-medium text-neutral-700">Design system code</h3>
        <p className="mb-3 text-xs text-neutral-400">
          Status:{" "}
          <span className={CODE_SYNC_STATUS_CLASS[component.codeSyncStatus] ?? "text-neutral-400"}>
            {CODE_SYNC_STATUS_LABEL[component.codeSyncStatus] ?? component.codeSyncStatus}
          </span>
          {component.lastCodeSyncAt && <> -- last generated {formatRelativeTime(component.lastCodeSyncAt)}</>}
          {component.lastCodeCommitSha && <> (commit {component.lastCodeCommitSha.slice(0, 7)})</>}
        </p>
        <ResyncComponentButton slug={component.slug} />
        <div className="mt-3 border-t border-neutral-100 pt-3">
          <DeleteComponentButton
            slug={component.slug}
            name={component.name}
            codeSyncStatus={component.codeSyncStatus}
            redirectTo="/design-system/components"
          />
        </div>
      </section>

      <DesignSystemPreview slug={component.slug} codeSyncStatus={component.codeSyncStatus} />

      {component.figmaNodeIds.length > 0 && (
        <section className="text-xs text-neutral-400">
          Figma node IDs:{" "}
          {component.figmaNodeIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              {figmaFileKey ? (
                <a
                  href={figmaNodeUrl(figmaFileKey, id)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-neutral-600 hover:underline"
                >
                  {id}
                </a>
              ) : (
                id
              )}
            </span>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Embeds the design-system repo's own Storybook (a separate Vercel
 * deployment, see README's "Design system code sync" section) rather than
 * ai-tools-app installing @d-2-g-8/design-system as a live dependency --
 * avoids bundler/peer-dependency/CSS-module-resolution edge cases for
 * zero real benefit here. iframe.html?id=... is Storybook's own
 * standalone-preview URL (no sidebar chrome); the id is fully derivable
 * from the slug alone (see storybookDefaultStoryId's doc comment) because
 * generateStories always emits a canonical "Default" story under a
 * deterministic title. "Open in Storybook" links to the full UI so
 * someone can browse the component's other variant/state stories too.
 */
function DesignSystemPreview({ slug, codeSyncStatus }: { slug: string; codeSyncStatus: string }) {
  const storybookUrl = process.env.DESIGN_SYSTEM_STORYBOOK_URL?.replace(/\/+$/, "");

  if (!storybookUrl) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h3 className="mb-1 text-sm font-medium text-neutral-700">Storybook preview</h3>
        <p className="text-xs text-neutral-400">
          Set DESIGN_SYSTEM_STORYBOOK_URL (see .env.example) once the design-system repo&apos;s Storybook is
          deployed, to preview this component live here.
        </p>
      </section>
    );
  }

  if (codeSyncStatus !== "committed") {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h3 className="mb-1 text-sm font-medium text-neutral-700">Storybook preview</h3>
        <p className="text-xs text-neutral-400">Generate this component&apos;s code above to preview it here.</p>
      </section>
    );
  }

  const storyId = storybookDefaultStoryId(slug);

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-700">Storybook preview</h3>
        <a
          href={`${storybookUrl}/?path=/story/${storyId}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-neutral-500 hover:underline"
        >
          Open in Storybook →
        </a>
      </div>
      <iframe
        src={`${storybookUrl}/iframe.html?id=${storyId}&viewMode=story`}
        title={`${slug} Storybook preview`}
        className="h-64 w-full rounded-md border border-neutral-100"
      />
    </section>
  );
}
