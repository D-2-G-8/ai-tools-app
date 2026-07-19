"use client";

import { useActionState } from "react";
import { runTool, type RunState } from "@/app/(protected)/tools/[toolKey]/actions";

interface PromptOption {
  id: string;
  name: string;
  isActive: boolean;
}

export function RunnerForm({
  toolKey,
  prompts,
  benefitsFromContext,
}: {
  toolKey: string;
  prompts: PromptOption[];
  benefitsFromContext: boolean;
}) {
  const boundAction = runTool.bind(null, toolKey);
  const [state, formAction, pending] = useActionState<RunState, FormData>(boundAction, {});
  const activePrompt = prompts.find((p) => p.isActive) ?? prompts[0];

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">Prompt</span>
          <select
            name="promptId"
            defaultValue={activePrompt?.id ?? ""}
            className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            {prompts.length === 0 && <option value="">(no prompts — add one on the "Prompts" tab)</option>}
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isActive ? " (active)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600">Input</span>
          <textarea
            name="userInput"
            rows={6}
            required
            placeholder="Describe the task / paste a diff / text — depending on the tool"
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-mono"
          />
        </label>

        {benefitsFromContext && (
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" name="useContext" defaultChecked className="rounded" />
            Use project context (RAG over uploaded documents)
          </label>
        )}

        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Running…" : "Run"}
        </button>
      </form>

      {state.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {state.error}
        </div>
      )}

      {state.output && (
        <div className="rounded-lg border border-neutral-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between text-xs text-neutral-400">
            <span>
              {state.inputTokens} / {state.outputTokens} tokens · ${state.costUsd?.toFixed(4)}
              {state.usedContext ? " · with project context" : ""}
            </span>
          </div>
          <pre className="whitespace-pre-wrap text-sm">{state.output}</pre>
        </div>
      )}
    </div>
  );
}
