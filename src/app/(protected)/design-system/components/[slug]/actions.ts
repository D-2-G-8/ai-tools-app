"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, designComponent } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getValidFigmaAccessToken } from "@/lib/figma/client";
import { resyncComponentFromFigma } from "@/lib/figma/sync";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";

export interface ResyncMetadataResult {
  ok: boolean;
  error?: string;
  summary?: string;
  codeSyncEnabled?: boolean;
}

/**
 * Step 1 of "Resync this component" (see resync-component-button.tsx):
 * re-fetches this component's Figma node and diffs its current variant
 * children against what's stored (src/lib/figma/sync.ts's
 * resyncComponentFromFigma), updating the DB row in place. Fast, no LLM or
 * GitHub calls, so a plain Server Action -- code generation (if the
 * workspace has it on) is a separate step that reuses the existing
 * per-component codegen route, same one the full "Generate code" flow
 * uses (see startComponentResyncBranch below).
 */
export async function resyncComponentMetadata(slug: string): Promise<ResyncMetadataResult> {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws) return { ok: false, error: "Workspace not found." };
  if (!ws.figmaFileKey) return { ok: false, error: "Set a Figma file key in Settings first, then sync." };

  const accessToken = await getValidFigmaAccessToken();
  if (!accessToken) {
    return { ok: false, error: "Figma isn't connected (or the connection expired) -- reconnect it in Settings." };
  }

  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  if (!component) return { ok: false, error: `Component "${slug}" not found.` };

  try {
    const result = await resyncComponentFromFigma(ws.figmaFileKey, accessToken, component);
    revalidatePath(`/design-system/components/${slug}`);
    return { ok: true, summary: result.summary, codeSyncEnabled: ws.designComponentStack !== "none" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Step 2 (only when code generation is on): opens/reuses this workspace's
 * current code-sync session branch, the same one "Generate code" and
 * "Resync tokens" use, so this component's commit lands on the same
 * not-yet-merged PR instead of opening a new one.
 */
export async function startComponentResyncBranch(): Promise<{ branchName: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const branchName = await getOrOpenSessionBranch(workspaceId);
  return { branchName };
}
