import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getTool } from "./registry";

/**
 * The default prompts from the tool registry are saved to the DB on the first
 * visit to a specific tool's "Prompts" tab — after that they are ordinary
 * editable prompt_template records.
 */
export async function ensureDefaultPrompts(toolKey: string) {
  const workspaceId = await getDefaultWorkspaceId();
  const tool = getTool(toolKey);
  if (!tool) return;

  const existing = await db
    .select()
    .from(promptTemplate)
    .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.toolKey, toolKey)))
    .limit(1);

  if (existing.length > 0 || tool.defaultPrompts.length === 0) return;

  await db.insert(promptTemplate).values(
    tool.defaultPrompts.map((p, i) => ({
      workspaceId,
      toolKey,
      name: p.name,
      content: p.content,
      isDefault: true,
      isActive: i === 0,
    })),
  );
}
