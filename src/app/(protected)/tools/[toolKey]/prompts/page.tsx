import { notFound } from "next/navigation";
import { db } from "@/db";
import { promptTemplate } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { getTool } from "@/lib/tools/registry";
import { ensureDefaultPrompts } from "@/lib/tools/prompts";
import { SetupNotice } from "@/components/setup-notice";
import { createPrompt, updatePrompt, deletePrompt, setActivePrompt } from "./actions";

export const dynamic = "force-dynamic";

export default async function ToolPromptsPage({
  params,
}: {
  params: Promise<{ toolKey: string }>;
}) {
  const { toolKey } = await params;
  const tool = getTool(toolKey);
  if (!tool) notFound();

  type PromptRow = typeof promptTemplate.$inferSelect;
  let prompts: PromptRow[] | null = null;
  let loadError: unknown = null;
  try {
    await ensureDefaultPrompts(toolKey);

    const workspaceId = await getCurrentWorkspaceId();
    prompts = await db
      .select()
      .from(promptTemplate)
      .where(and(eq(promptTemplate.workspaceId, workspaceId), eq(promptTemplate.toolKey, toolKey)))
      .orderBy(sql`${promptTemplate.createdAt} asc`);
  } catch (err) {
    loadError = err;
  }

  if (loadError || !prompts) {
    return <SetupNotice error={loadError} />;
  }

  return (
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          {prompts.length === 0 && (
            <p className="text-sm text-neutral-400">
              No default prompts for this tool yet — add your own below.
            </p>
          )}
          {prompts.map((p) => (
            <div key={p.id} className="rounded-lg border border-neutral-200 bg-white p-4">
              {/*
                The "set active" control is deliberately kept OUTSIDE the
                update form below rather than nested inside it. HTML forbids
                a form element inside another form element -- browsers
                silently mis-parse that, which desyncs React's tracked form
                elements from the real DOM and made "Set active" submit
                unreliably (or not at all) instead of triggering
                setActivePrompt.
              */}
              <div className="mb-2 flex items-center justify-end gap-2">
                {p.isDefault && (
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                    default
                  </span>
                )}
                {p.isActive ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
                    active
                  </span>
                ) : (
                  <form action={setActivePrompt.bind(null, toolKey, p.id)}>
                    <button type="submit" className="text-xs text-neutral-500 hover:underline">
                      Set active
                    </button>
                  </form>
                )}
              </div>
              <form action={updatePrompt.bind(null, toolKey, p.id)} className="flex flex-col gap-2">
                <input
                  name="name"
                  defaultValue={p.name}
                  className="w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-medium"
                />
                <textarea
                  name="content"
                  defaultValue={p.content}
                  rows={5}
                  className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm font-mono"
                />
                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50"
                  >
                    Save
                  </button>
                  <span className="text-xs text-neutral-400">
                    Placeholders like {"{{"}name{"}}"} are substituted at run time
                  </span>
                </div>
              </form>
              <form action={deletePrompt.bind(null, toolKey, p.id)} className="mt-1">
                <button type="submit" className="text-xs text-red-600 hover:underline">
                  Delete
                </button>
              </form>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-dashed border-neutral-300 p-4">
          <h2 className="text-sm font-medium text-neutral-700 mb-3">New prompt</h2>
          <form action={createPrompt.bind(null, toolKey)} className="flex flex-col gap-2">
            <input
              name="name"
              placeholder="Name"
              required
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
            <textarea
              name="content"
              placeholder="Prompt text"
              required
              rows={4}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm font-mono"
            />
            <button
              type="submit"
              className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Add
            </button>
          </form>
        </section>
      </div>
  );
}
