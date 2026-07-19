import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { promptTemplate, run as runTable, chatMessage, featureWorkflow, document } from "@/db/schema";
import { eq, and, sql, desc, asc } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getTool } from "@/lib/tools/registry";
import { ensureDefaultPrompts } from "@/lib/tools/prompts";
import { SetupNotice } from "@/components/setup-notice";
import { RunnerForm } from "@/components/runner-form";
import { ChatStart, ChatConversation } from "@/components/chat-runner";
import { CodeReviewPanel } from "@/components/code-review-panel";
import { loadOpenMergeRequests } from "./code-review-actions";

export const dynamic = "force-dynamic";

/**
 * AI Review (see code-review-actions.ts / code-review-panel.tsx): pulls
 * live open MRs from GitLab rather than driving a prompt+input run, so it
 * gets its own loader and its own branch below -- same special-casing
 * pattern this page already uses for chatMode tools.
 */
async function loadCodeReviewData() {
  const workspaceId = await getCurrentWorkspaceId();
  const { readiness, projects } = await loadOpenMergeRequests();
  const documents = await db
    .select({ id: document.id, filename: document.filename })
    .from(document)
    .where(and(eq(document.workspaceId, workspaceId), eq(document.status, "ready")))
    .orderBy(document.filename);

  return { ready: readiness.ready, setupMessage: readiness.message, projects, documents };
}

async function loadChatData(toolKey: string, runParam?: string, featureParam?: string) {
  const workspaceId = await getCurrentWorkspaceId();

  let activeRun: typeof runTable.$inferSelect | undefined;

  if (runParam) {
    [activeRun] = await db.select().from(runTable).where(eq(runTable.id, runParam)).limit(1);
  } else if (featureParam) {
    [activeRun] = await db
      .select()
      .from(runTable)
      .where(and(eq(runTable.featureWorkflowId, featureParam), eq(runTable.toolKey, toolKey)))
      .orderBy(desc(runTable.createdAt))
      .limit(1);
  }

  let messages: (typeof chatMessage.$inferSelect)[] = [];
  let resultDocumentFilename: string | null = null;
  if (activeRun) {
    messages = await db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.runId, activeRun.id))
      .orderBy(asc(chatMessage.createdAt));

    if (activeRun.resultDocumentId) {
      const [doc] = await db
        .select({ filename: document.filename })
        .from(document)
        .where(eq(document.id, activeRun.resultDocumentId))
        .limit(1);
      resultDocumentFilename = doc?.filename ?? null;
    }
  }

  // ?feature= but no run yet for this tool (e.g. a feature created before
  // this tool existed) — hand the feature back so "start" attaches to it
  // instead of creating a second, disconnected feature_workflow.
  let feature: typeof featureWorkflow.$inferSelect | undefined;
  if (!activeRun && featureParam) {
    [feature] = await db.select().from(featureWorkflow).where(eq(featureWorkflow.id, featureParam)).limit(1);
  }

  const recentRuns = await db
    .select({
      id: runTable.id,
      status: runTable.status,
      inputSummary: runTable.inputSummary,
    })
    .from(runTable)
    .where(and(eq(runTable.workspaceId, workspaceId), eq(runTable.toolKey, toolKey)))
    .orderBy(desc(runTable.createdAt))
    .limit(10);

  return { activeRun, messages, resultDocumentFilename, recentRuns, feature };
}

export default async function ToolRunnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ toolKey: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { toolKey } = await params;
  const tool = getTool(toolKey);
  if (!tool) notFound();

  if (toolKey === "code-review") {
    let data: Awaited<ReturnType<typeof loadCodeReviewData>> | null = null;
    let loadError: unknown = null;
    try {
      data = await loadCodeReviewData();
    } catch (err) {
      loadError = err;
    }

    if (loadError || !data) {
      return <SetupNotice error={loadError} />;
    }

    return <CodeReviewPanel ready={data.ready} setupMessage={data.setupMessage} projects={data.projects} documents={data.documents} />;
  }

  if (tool.chatMode) {
    const sp = await searchParams;
    const runParam = typeof sp.run === "string" ? sp.run : undefined;
    const featureParam = typeof sp.feature === "string" ? sp.feature : undefined;

    let data: Awaited<ReturnType<typeof loadChatData>> | null = null;
    let loadError: unknown = null;
    try {
      await ensureDefaultPrompts(toolKey);
      data = await loadChatData(toolKey, runParam, featureParam);
    } catch (err) {
      loadError = err;
    }

    if (loadError || !data) {
      return <SetupNotice error={loadError} />;
    }

    const { activeRun, messages, resultDocumentFilename, recentRuns, feature } = data;

    if (activeRun) {
      return (
        <ChatConversation
          toolKey={toolKey}
          runId={activeRun.id}
          status={activeRun.status}
          messages={messages.map((m) => ({ id: m.id, role: m.role, content: m.content }))}
          resultDocumentFilename={resultDocumentFilename}
        />
      );
    }

    return (
      <div className="flex flex-col gap-6">
        <ChatStart toolKey={toolKey} featureWorkflowId={feature?.id} />
        {recentRuns.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-neutral-600 mb-2">Conversations</h2>
            <ul className="flex flex-col gap-2">
              {recentRuns.map((r) => (
                <li key={r.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-neutral-600">{r.inputSummary}</div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-neutral-400">{r.status}</span>
                      <Link href={`/tools/${toolKey}?run=${r.id}`} className="text-xs text-neutral-600 hover:underline">
                        Open
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  let prompts: { id: string; name: string; isActive: boolean }[] | null = null;
  let loadError: unknown = null;
  try {
    await ensureDefaultPrompts(toolKey);
    const workspaceId = await getCurrentWorkspaceId();
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
