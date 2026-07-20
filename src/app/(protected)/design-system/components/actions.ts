"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { designComponent } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { componentSourcePaths } from "@/lib/design-system-codegen/component";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";
import { commitFiles } from "@/lib/github/client";
import { finishCodeGenSession } from "../settings/codegen-actions";

export interface DeleteComponentResult {
  ok: boolean;
  error?: string;
  /** Set when this component's code also had to be removed from the design-system repo. */
  prUrl?: string;
}

/**
 * Deletes a design_component row (see delete-component-button.tsx).
 *
 * IMPORTANT: metadata sync (src/lib/figma/sync.ts) is upsert-only and never
 * deletes -- see that file's upsertComponent. If this component's Figma
 * node still exists in the currently-synced file, the NEXT full sync (or a
 * targeted "Resync this component" for it, though you obviously can't
 * click that once it's gone) will just recreate the platform row, since
 * sync has no memory of "a person deleted this on purpose" -- see the
 * "last synced" timestamp, which flags rows the most recent sync didn't
 * touch (orphaned -- won't come back) vs ones it just confirmed.
 *
 * If code has already been generated for this component (codeSyncStatus
 * === "committed" -- it's real code living in the design-system repo that
 * other services may already depend on), a plain DB delete isn't enough:
 * this also commits a removal of its file set (componentSourcePaths) to
 * the workspace's current code-sync branch and opens/updates the PR --
 * same human-in-the-loop merge as every other code-sync write (see
 * src/lib/github/client.ts's mergePullRequest doc comment). The DB row is
 * only deleted AFTER that commit succeeds, so a GitHub-side failure
 * leaves the platform row intact rather than silently going out of sync
 * with the repo.
 */
export async function deleteComponent(slug: string): Promise<DeleteComponentResult> {
  const workspaceId = await getCurrentWorkspaceId();
  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  if (!component) return { ok: true }; // already gone -- nothing to do

  if (component.codeSyncStatus === "committed") {
    try {
      const paths = componentSourcePaths(component.slug, component.isIcon);
      const branchName = await getOrOpenSessionBranch(workspaceId);
      await commitFiles(branchName, `Remove ${paths.componentName}`, [
        { path: paths.tsxPath, content: null },
        { path: paths.cssPath, content: null },
        { path: paths.storiesPath, content: null },
        { path: paths.indexPath, content: null },
      ]);
      const { prUrl } = await finishCodeGenSession(branchName);

      await db.delete(designComponent).where(eq(designComponent.id, component.id));
      revalidatePath("/design-system/components");
      revalidatePath(`/design-system/components/${slug}`);
      revalidatePath("/design-system/settings");
      return { ok: true, prUrl };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  await db.delete(designComponent).where(eq(designComponent.id, component.id));
  revalidatePath("/design-system/components");
  revalidatePath(`/design-system/components/${slug}`);
  return { ok: true };
}

export interface MergeComponentsResult {
  ok: boolean;
  error?: string;
  mergedSlug?: string;
}

/**
 * Merges multiple design_component rows into one -- for duplicates the
 * automatic same-name merge in src/lib/figma/sync.ts's buildComponentGroups
 * doesn't catch because they don't share a literal Figma name (e.g.
 * "Button Primary" / "Button Secondary" modeled as separate Figma
 * components instead of variants of one shared "Button"). Variants/states
 * union via a Map keyed by label -- an identical one coming from two
 * merged rows collapses into one, never duplicating, same rule the
 * automatic merge uses -- and figmaNodeIds union via a Set. The surviving
 * row is the OLDEST (earliest createdAt) of the selected ones: a
 * deterministic rule that doesn't need a "pick the primary" UI step.
 *
 * Refuses if ANY selected component already has generated code
 * (codeSyncStatus === "committed"): merging would leave that code
 * orphaned under a slug this is about to delete. Remove that code first
 * (Delete -- see deleteComponent above), merge, then regenerate.
 */
export async function mergeComponents(slugs: string[]): Promise<MergeComponentsResult> {
  const workspaceId = await getCurrentWorkspaceId();
  const unique = Array.from(new Set(slugs));
  if (unique.length < 2) return { ok: false, error: "Select at least 2 components to merge." };

  const rows = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), inArray(designComponent.slug, unique)));
  if (rows.length !== unique.length) {
    return { ok: false, error: "One or more selected components weren't found -- try refreshing." };
  }

  const codeSynced = rows.filter((r) => r.codeSyncStatus === "committed");
  if (codeSynced.length > 0) {
    return {
      ok: false,
      error: `Can't merge -- ${codeSynced.map((r) => r.name).join(", ")} already ${codeSynced.length === 1 ? "has" : "have"} generated code. Remove that code first (Delete), then merge, then regenerate.`,
    };
  }

  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const primary = sorted[0];
  const rest = sorted.slice(1);

  const variantMap = new Map(primary.variants.map((v) => [v.name, v]));
  const stateMap = new Map(primary.states.map((s) => [s.name, s]));
  const nodeIds = new Set(primary.figmaNodeIds);
  let description = primary.description;
  let isIcon = primary.isIcon;

  for (const r of rest) {
    for (const v of r.variants) if (!variantMap.has(v.name)) variantMap.set(v.name, v);
    for (const s of r.states) if (!stateMap.has(s.name)) stateMap.set(s.name, s);
    for (const id of r.figmaNodeIds) nodeIds.add(id);
    description = description || r.description;
    isIcon = isIcon || r.isIcon;
  }

  await db
    .update(designComponent)
    .set({
      variants: Array.from(variantMap.values()),
      states: Array.from(stateMap.values()),
      figmaNodeIds: Array.from(nodeIds),
      description,
      isIcon,
      updatedAt: new Date(),
    })
    .where(eq(designComponent.id, primary.id));

  await db.delete(designComponent).where(
    inArray(
      designComponent.id,
      rest.map((r) => r.id),
    ),
  );

  revalidatePath("/design-system/components");
  revalidatePath(`/design-system/components/${primary.slug}`);
  for (const r of rest) revalidatePath(`/design-system/components/${r.slug}`);

  return { ok: true, mergedSlug: primary.slug };
}
