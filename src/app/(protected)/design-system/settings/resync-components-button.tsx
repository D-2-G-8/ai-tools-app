"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { resyncComponents } from "./codegen-actions";

type ResyncState = "idle" | "running" | "done" | "error";

/**
 * "Resync components" -- re-lists every component without touching
 * tokens/styles, symmetric with ResyncTokensButton. Smaller/faster than
 * "Sync now" (FigmaSyncButton, which also re-lists every style) for when
 * only components changed. Metadata only -- doesn't trigger code
 * generation for anything, see codegen-actions.ts's resyncComponents.
 */
export function ResyncComponentsButton() {
  const router = useRouter();
  const [state, setState] = useState<ResyncState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    setMessage(null);

    try {
      const result = await resyncComponents();
      if (!result.ok) {
        setState("error");
        setMessage(result.error ?? "Resync failed.");
        return;
      }
      setState("done");
      setMessage(result.summary ?? "Components resynced.");
      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [state, router]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        className="self-start rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "running" ? "Resyncing components..." : "Resync components only"}
      </button>

      {message && (
        <p
          className={`rounded-md px-3 py-2 text-xs ${
            state === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
