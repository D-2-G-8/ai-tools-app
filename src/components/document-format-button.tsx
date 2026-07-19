"use client";

import { useActionState, useState } from "react";
import { formatDocumentContent, type FormatDocumentState } from "@/app/(protected)/documents/format-actions";
import { updateDocumentContent } from "@/app/(protected)/documents/actions";
import { splitMarkdownFences } from "@/lib/markdown/split-fences";
import { DocumentSegments } from "./document-segments";

function SparklesIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
      aria-hidden="true"
    >
      <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z" />
      <path d="M18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
    </svg>
  );
}

/**
 * "Format" -- AI-assisted markdown cleanup for a single document. Common
 * breakage after export is misaligned/broken tables, but what exactly is
 * wrong isn't always obvious at a glance, hence an AI pass rather than a
 * fixed set of regex fixes.
 *
 * This never touches the document by itself: a click proposes a reformatted
 * version (rendered with the exact same DocumentSegments the real page
 * uses, so the preview is a true preview), and the user explicitly Applies
 * it (reuses updateDocumentContent -- the same save path as the manual
 * editor, including re-ingest) or Cancels (pure client-side state reset, no
 * server call).
 */
export function DocumentFormatButton({ documentId }: { documentId: string }) {
  const boundFormat = formatDocumentContent.bind(null, documentId);
  const [state, formAction, pending] = useActionState<FormatDocumentState, FormData>(boundFormat, {});

  // A fresh result (including re-running Format after a Cancel) should
  // always show the preview again. Rather than an effect + setState (which
  // causes an extra render pass), this follows React's documented pattern
  // for resetting state when a value changes: track the last-seen `state`
  // reference and reset `dismissed` synchronously during render, the one
  // time it actually differs -- see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevState, setPrevState] = useState(state);
  const [dismissed, setDismissed] = useState(false);
  if (state !== prevState) {
    setPrevState(state);
    setDismissed(false);
  }

  if (state.formatted && !dismissed) {
    const segments = splitMarkdownFences(state.formatted);
    return (
      <div className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-blue-900">Proposed formatting</p>
            <p className="text-xs text-blue-700">Review the result below, then apply it or cancel.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <form action={updateDocumentContent.bind(null, documentId)}>
              <input type="hidden" name="content" value={state.formatted} />
              <button
                type="submit"
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700"
              >
                Apply
              </button>
            </form>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs hover:bg-neutral-50"
            >
              Cancel
            </button>
          </div>
        </div>
        <div className="rounded-md border border-neutral-200 bg-white p-4">
          <DocumentSegments segments={segments} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          title="Format"
          aria-label="Format"
          className="flex items-center justify-center rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-50"
        >
          <SparklesIcon spinning={pending} />
        </button>
      </form>
      {state.error && <span className="text-xs text-red-600">{state.error}</span>}
    </div>
  );
}
