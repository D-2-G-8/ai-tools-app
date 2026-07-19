"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, toolSettings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { updateSessionSecrets, clearSessionSecrets } from "@/lib/session";

export async function saveGeneralSettings(formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();

  const gitlabUrl = String(formData.get("gitlabUrl") ?? "").trim();
  const gitlabToken = String(formData.get("gitlabToken") ?? "").trim();
  const llmProviderUrl = String(formData.get("llmProviderUrl") ?? "").trim();
  const llmProviderToken = String(formData.get("llmProviderToken") ?? "").trim();

  // URL-ы (не секрет) — в БД, персистентно.
  await db
    .update(workspace)
    .set({
      gitlabUrl: gitlabUrl || null,
      defaultLlmProviderUrl: llmProviderUrl || null,
    })
    .where(eq(workspace.id, workspaceId));

  // Токены — только в сессию. Пустое поле не затирает уже сохранённый токен
  // (чтобы не приходилось вводить заново при каждом сохранении других полей).
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

export async function saveToolModel(toolKey: string, formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();
  const model = String(formData.get("model") ?? "").trim();
  const providerBaseUrl = String(formData.get("providerBaseUrl") ?? "").trim();

  if (!model) return;

  const existing = await db
    .select()
    .from(toolSettings)
    .where(and(eq(toolSettings.workspaceId, workspaceId), eq(toolSettings.toolKey, toolKey)))
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
      model,
      providerBaseUrl: providerBaseUrl || null,
    });
  }

  revalidatePath("/settings");
}
