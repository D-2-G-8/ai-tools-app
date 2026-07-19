"use client";

import { useActionState } from "react";
import { askDocumentsQuestion, type DocumentsQAState } from "@/app/documents/qa-actions";

export function DocumentsQA() {
  const [state, formAction, pending] = useActionState<DocumentsQAState, FormData>(askDocumentsQuestion, {});

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="text-sm font-medium text-neutral-700 mb-1">Ask about your documents</h2>
      <p className="mb-4 text-xs text-neutral-400">
        Answers are generated from your uploaded documents only (RAG search), not general knowledge.
      </p>
      <form action={formAction} className="flex flex-col gap-3">
        <textarea
          name="question"
          rows={2}
          required
          placeholder="e.g. how does listing blocking currently work?"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Thinking…" : "Ask"}
        </button>
      </form>

      {state.error && <p className="mt-3 text-sm text-red-600">{state.error}</p>}

      {state.answer && (
        <div className="mt-4 flex flex-col gap-3 border-t border-neutral-100 pt-4">
          <p className="whitespace-pre-wrap text-sm text-neutral-900">{state.answer}</p>

          {state.citations && state.citations.length > 0 && (
            <div className="text-xs text-neutral-400">
              Sources:{" "}
              {state.citations.map((c, i) => (
                <span key={i}>
                  [{i + 1}] {c.filename}
                  {c.headingPath ? ` (${c.headingPath})` : ""}
                  {i < state.citations!.length - 1 ? " · " : ""}
                </span>
              ))}
            </div>
          )}

          <div className="text-xs text-neutral-400">
            {state.inputTokens} / {state.outputTokens} tokens · ${state.costUsd?.toFixed(4)}
          </div>
        </div>
      )}
    </section>
  );
}
