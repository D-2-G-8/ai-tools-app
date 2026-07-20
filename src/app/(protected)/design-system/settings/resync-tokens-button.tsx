"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { resyncTokens } from "./codegen-actions";

type ResyncState = "idle" | "running" | "done" | "error";

/**
 * "Resync tokens" -- re-fetches just Figma's styles and regenerates/
 * commits tokens.css, without touching any component. Smaller/faster than
 * "Sync now" (FigmaSyncButton, which also re-lists every component) for
 * when only colors/type/spacing changed. See codegen-actions.ts's
 * resyncTokens.
 */
export function ResyncTokensButton() {
  const router = useRouter();
  const [state, setState] = useState<ResyncState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    setMessage(null);
    setPrUrl(null);

    try {
      const result = await resyncTokens();
      if (!result.ok) {
        setState("error");
        setMessage(result.error ?? "Resync failed.");
        return;
      }
      setState("done");
      setMessage(result.summary ?? "Tokens resynced.");
      setPrUrl(result.prUrl ?? null);
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
        {state === "running" ? "Resyncing tokens..." : "Resync tokens only"}
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

      {prUrl && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          Committed to{" "}
          <a href={prUrl} target="_blank" rel="noreferrer" className="underline">
            pull request
          </a>
          .
        </p>
      )}
    </div>
  );
}
