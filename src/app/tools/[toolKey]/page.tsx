import { notFound } from "next/navigation";
import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { getTool } from "@/lib/tools/registry";
import { ensureDefaultPrompts } from "@/lib/tools/prompts";
import { SetupNotice } from "@/components/setup-notice";
import { RunnerForm } from "@/components/runner-form";

export const dynamic = "force-dynamic";

export default async function ToolRunnerPage({
  params,
}: {
  params: Promise<{ toolKey: string }>;
}) {
  const { toolKey } = await params;
  const tool = getTool(toolKey);
  if (!tool) notFound();

  let prompts: { id: string; name: string; isActive: boolean }[] | null = null;
  let loadError: unknown = null;
  try {
    await ensureDefaultPrompts(toolKey);
    const workspaceId = await getDefaultWorkspaceId();
    prompts = await db
      .select({ id: promptTemplate.id, name: promptTemplate.name, isActive: promptTemplate.isActive })
      .from(promptTemplate)
      .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.toolKey, toolKey)))
      .orderBy(sql`${promptTemplate.createdAt} asc`);
  } catch (err) {
    loadError = err;
  }

  if (loadError || !prompts) {
    return <SetupNotice error={loadError} />;
  }

  return <RunnerForm toolKey={toolKey} prompts={prompts} benefitsFromContext={tool.benefitsFromContext} />;
}
