import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getTool } from "./registry";

/**
 * Дефолтные промпты из реестра инструментов сохраняются в БД при первом
 * обращении к вкладке "Промпты" конкретного инструмента — дальше это
 * обычные редактируемые записи prompt_template.
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
