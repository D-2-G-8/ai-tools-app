"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, toolSettings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getCurrentUser } from "@/db/users";
import { updateSessionSecrets, clearSessionSecrets, disconnectFigmaSession } from "@/lib/session";

export async function saveGeneralSettings(formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();

  const gitlabUrl = String(formData.get("gitlabUrl") ?? "").trim();
  const gitlabProjectIds = String(formData.get("gitlabProjectIds") ?? "").trim();
  const gitlabToken = String(formData.get("gitlabToken") ?? "").trim();
  const llmProviderUrl = String(formData.get("llmProviderUrl") ?? "").trim();
  const llmProviderToken = String(formData.get("llmProviderToken") ?? "").trim();

  // URLs and project IDs (not secret) — stored in the DB, persistently.
  await db
    .update(workspace)
    .set({
      gitlabUrl: gitlabUrl || null,
      gitlabProjectIds: gitlabProjectIds || null,
      defaultLlmProviderUrl: llmProviderUrl || null,
    })
    .where(eq(workspace.id, workspaceId));

  // Tokens — session only. An empty field does not overwrite an already-saved token
  // (so you don't have to re-enter it every time you save other fields).
  const patch: Record<string, string> = {};
  if (gitlabToken) patch.gitlabToken = gitlabToken;
  if (llmProviderToken) patch.llmProviderToken = llmProviderToken;
  if (gitlabUrl) patch.gitlabUrl = gitlabUrl;
  if (llmProviderUrl) patch.llmProviderUrl = llmProviderUrl;
  if (Object.keys(patch).length > 0) {
    await updateSessionSecrets(patch);
  }

  revalidatePath("/settings");
}

export async function clearSecrets() {
  await clearSessionSecrets();
  revalidatePath("/settings");
}

/** "Disconnect" button next to the Figma connection status. */
export async function disconnectFigma() {
  await disconnectFigmaSession();
  revalidatePath("/settings");
  redirect("/settings?figma=disconnected");
}

/**
 * Saves the SIGNED-IN USER's own model choice for a tool -- see
 * src/lib/tools/model-settings.ts. Always reads/writes the row keyed by
 * (workspaceId, toolKey, userId=them); it never touches the legacy
 * company-wide row (userId IS NULL), so saving your own preference can
 * never change what a teammate who hasn't set one yet still falls back to.
 */
export async function saveToolModel(toolKey: string, formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();
  const currentUser = await getCurrentUser();
  if (!currentUser) return;

  const model = String(formData.get("model") ?? "").trim();
  const providerBaseUrl = String(formData.get("providerBaseUrl") ?? "").trim();

  if (!model) return;

  const existing = await db
    .select()
    .from(toolSettings)
    .where(
      and(
        eq(toolSettings.workspaceId, workspaceId),
        eq(toolSettings.toolKey, toolKey),
        eq(toolSettings.userId, currentUser.id),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(toolSettings)
      .set({ model, providerBaseUrl: providerBaseUrl || null, updatedAt: new Date() })
      .where(eq(toolSettings.id, existing[0].id));
  } else {
    await db.insert(toolSettings).values({
      workspaceId,
      toolKey,
      userId: currentUser.id,
      model,
      providerBaseUrl: providerBaseUrl || null,
    });
  }

  revalidatePath("/settings");
}
