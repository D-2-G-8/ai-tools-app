import "server-only";
import { db } from "@/db";
import { designToken, designComponent, type DesignTokenCategory } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { TokenForCss } from "./tokens";

/** Every synced token for a workspace, shaped for tokens.css generation / component codegen prompts. */
export async function loadTokensForCss(workspaceId: string): Promise<TokenForCss[]> {
  const rows = await db.select().from(designToken).where(eq(designToken.workspaceId, workspaceId));
  return rows.map((r) => ({
    name: r.name,
    // designToken.category is a plain varchar (not a pg enum) -- values are
    // constrained at write time by Figma sync (designTokenCategoryValues),
    // not by the DB itself. Same assumption the tokens/components pages
    // already make when grouping by category.
    category: r.category as DesignTokenCategory,
    value: r.value,
  }));
}

export async function loadComponentBySlug(workspaceId: string, slug: string) {
  const [row] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** Every component's slug + code-sync status for a workspace -- drives the "Generate code" client orchestration. */
export async function loadComponentSlugsForWorkspace(workspaceId: string) {
  const rows = await db
    .select({ slug: designComponent.slug, name: designComponent.name })
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId));
  return rows;
}

/**
 * Counts for design-system/settings's Cleanup section -- how many
 * components/tokens are metadata-only vs already committed to the
 * design-system repo, since bulk-clearing each bucket does something
 * different (see settings/cleanup-actions.ts).
 */
export async function loadCleanupCounts(workspaceId: string) {
  const components = await db
    .select({ codeSyncStatus: designComponent.codeSyncStatus })
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId));
  const tokens = await db
    .select({ lastCodeSyncAt: designToken.lastCodeSyncAt })
    .from(designToken)
    .where(eq(designToken.workspaceId, workspaceId));

  const componentsCodeSynced = components.filter((c) => c.codeSyncStatus === "committed").length;
  const tokensCodeSynced = tokens.filter((t) => t.lastCodeSyncAt !== null).length;

  return {
    componentsUnsynced: components.length - componentsCodeSynced,
    componentsCodeSynced,
    tokensUnsynced: tokens.length - tokensCodeSynced,
    tokensCodeSynced,
  };
}
