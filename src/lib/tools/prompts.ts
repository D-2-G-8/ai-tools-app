import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getTool } from "./registry";

/**
 * The default prompts from the tool registry are saved to the DB on the first
 * visit to a specific tool's "Prompts" tab — after that they are ordinary
 * editable prompt_template records.
 *
 * If the tool still has exactly the single untouched shipped default (same
 * name, unmodified since seeding) but registry.ts has since changed its
 * content — e.g. a chat-mode interview prompt got redesigned — refresh it in
 * place. Anything the user has renamed, edited into a second prompt, or
 * added alongside is left alone.
 */
export async function ensureDefaultPrompts(toolKey: string) {
  const workspaceId = await getDefaultWorkspaceId();
  const tool = getTool(toolKey);
  if (!tool || tool.defaultPrompts.length === 0) return;

  const existing = await db
    .select()
    .from(promptTemplate)
    .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.toolKey, toolKey)));

  if (existing.length === 0) {
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
    return;
  }

  const [only] = existing;
  const shipped = tool.defaultPrompts[0];
  if (existing.length === 1 && only.isDefault && shipped && only.name === shipped.name && only.content !== shipped.content) {
    await db
      .update(promptTemplate)
      .set({ content: shipped.content, updatedAt: new Date() })
      .where(eq(promptTemplate.id, only.id));
  }
}
