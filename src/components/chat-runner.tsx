"use client";

import { useActionState, useEffect, useRef } from "react";
import { startChat, sendChatMessage, type ChatActionState } from "@/app/(protected)/tools/[toolKey]/chat-actions";

interface ChatMessageItem {
  id: string;
  role: string;
  content: string;
}

/** Shown when no conversation is selected yet — the very first message both
 * kicks off a new feature and starts the interview, no separate setup step. */
export function ChatStart({ toolKey, featureWorkflowId }: { toolKey: string; featureWorkflowId?: string }) {
  const boundAction = startChat.bind(null, toolKey);
  const [state, formAction, pending] = useActionState<ChatActionState, FormData>(boundAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
      {featureWorkflowId && <input type="hidden" name="featureWorkflowId" value={featureWorkflowId} />}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600">Describe what you need</span>
        <textarea
          name="message"
          rows={4}
          required
          placeholder="e.g. we need to be able to block listings in the catalog"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {pending ? "Starting…" : "Start"}
      </button>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}

export function ChatConversation({
  toolKey,
  runId,
  status,
  messages,
  resultDocumentFilename,
}: {
  toolKey: string;
  runId: string;
  status: string;
  messages: ChatMessageItem[];
  resultDocumentFilename?: string | null;
}) {
  const boundAction = sendChatMessage.bind(null, toolKey, runId);
  const [state, formAction, pending] = useActionState<ChatActionState, FormData>(boundAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the textarea after a successful send — but not when the action
  // returned a validation error, so the user doesn't lose what they typed.
  useEffect(() => {
    if (!state.error) formRef.current?.reset();
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      {status === "completed" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          The document is ready{resultDocumentFilename ? ` — "${resultDocumentFilename}"` : ""}. Find it on the{" "}
          <a href="/documents" className="underline">
            Documents
          </a>{" "}
          page. You can keep chatting to refine or extend it — the document will be updated.
        </div>
      )}
      {status === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          The last message couldn&apos;t be processed — try sending it again.
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
              m.role === "user" ? "self-end bg-neutral-900 text-white" : "self-start bg-neutral-100 text-neutral-900"
            }`}
          >
            {m.content}
          </div>
        ))}
        {pending && (
          <div className="self-start rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-400">Typing…</div>
        )}
      </div>

      <form ref={formRef} action={formAction} className="flex items-end gap-3">
        <textarea
          name="message"
          rows={2}
          required
          placeholder="Your reply…"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "…" : "Send"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
    </div>
  );
}
