"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";

export async function createPrompt(toolKey: string, formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();
  const name = String(formData.get("name") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  if (!name || !content) return;

  await db.insert(promptTemplate).values({
    workspaceId,
    toolKey,
    name,
    content,
    isDefault: false,
    isActive: false,
  });

  revalidatePath(`/tools/${toolKey}/prompts`);
}

export async function updatePrompt(toolKey: string, promptId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  if (!name || !content) return;

  await db
    .update(promptTemplate)
    .set({ name, content, updatedAt: new Date() })
    .where(eq(promptTemplate.id, promptId));

  revalidatePath(`/tools/${toolKey}/prompts`);
}

export async function deletePrompt(toolKey: string, promptId: string) {
  await db.delete(promptTemplate).where(eq(promptTemplate.id, promptId));
  revalidatePath(`/tools/${toolKey}/prompts`);
}

export async function setActivePrompt(toolKey: string, promptId: string) {
  const workspaceId = await getCurrentWorkspaceId();
  await db
    .update(promptTemplate)
    .set({ isActive: false })
    .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.toolKey, toolKey)));
  await db.update(promptTemplate).set({ isActive: true }).where(eq(promptTemplate.id, promptId));
  revalidatePath(`/tools/${toolKey}/prompts`);
}
