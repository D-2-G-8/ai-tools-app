"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface SyncProgressEvent {
  phase: "scope" | "tokens" | "components" | "done" | "error";
  message?: string;
  done?: number;
  total?: number;
}

type SyncState = "idle" | "syncing" | "done" | "error";

function describeEvent(event: SyncProgressEvent): string | null {
  if (event.phase === "scope") return event.message ?? "Checking what needs to sync...";
  if (event.phase === "tokens") return `Tokens: ${event.done ?? 0}/${event.total ?? 0}`;
  if (event.phase === "components") return `Components: ${event.done ?? 0}/${event.total ?? 0}`;
  if (event.phase === "done") return event.message ?? "Sync complete.";
  if (event.phase === "error") return event.message ?? "Sync failed.";
  return null;
}

/**
 * "Sync now" button + live progress log for the design-system Settings
 * page. A client component (unlike the rest of this page's plain Server
 * Action forms) because it consumes Server-Sent Events from
 * /api/figma/sync (see that route) to show progress as it happens -- added
 * after a real sync ran for a while with zero visibility into what was
 * going on.
 */
export function FigmaSyncButton() {
  const router = useRouter();
  const [state, setState] = useState<SyncState>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Tracks whether we've already handled the terminal event, so the
  // EventSource's own onerror (which also fires on a normal stream close --
  // a well-known EventSource quirk) doesn't overwrite a clean finish with a
  // spurious "lost connection" message.
  const finishedRef = useRef(false);

  const startSync = useCallback(() => {
    if (state === "syncing") return;
    setState("syncing");
    setLines([]);
    setErrorMessage(null);
    finishedRef.current = false;

    const es = new EventSource("/api/figma/sync");
    // One line per phase for "tokens"/"components", updated in place as
    // done/total change, instead of appending -- otherwise a 40-token file
    // would print 40 lines instead of one live-updating counter.
    const phaseLineIndex: Partial<Record<SyncProgressEvent["phase"], number>> = {};

    es.onmessage = (raw) => {
      let event: SyncProgressEvent;
      try {
        event = JSON.parse(raw.data) as SyncProgressEvent;
      } catch {
        return;
      }
      const text = describeEvent(event);

      if (event.phase === "done" || event.phase === "error") {
        finishedRef.current = true;
        es.close();
        setState(event.phase === "done" ? "done" : "error");
        if (event.phase === "error") setErrorMessage(event.message ?? "Sync failed.");
        if (text) setLines((prev) => [...prev, text]);
        // Re-fetch server data (token/component lists, the result banner's
        // counts) now that the sync route's revalidatePath calls have run.
        if (event.phase === "done") router.refresh();
        return;
      }

      if (!text) return;
      setLines((prev) => {
        const idx = phaseLineIndex[event.phase];
        if (idx !== undefined) {
          const next = [...prev];
          next[idx] = text;
          return next;
        }
        const next = [...prev, text];
        if (event.phase === "tokens" || event.phase === "components") {
          phaseLineIndex[event.phase] = next.length - 1;
        }
        return next;
      });
    };

    es.onerror = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      es.close();
      setState("error");
      setErrorMessage("Lost connection to the server during sync.");
    };
  }, [state, router]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={startSync}
        disabled={state === "syncing"}
        className="self-start rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "syncing" ? "Syncing..." : "Sync now"}
      </button>

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-600">
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {state === "error" && errorMessage && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
      )}
    </div>
  );
}
