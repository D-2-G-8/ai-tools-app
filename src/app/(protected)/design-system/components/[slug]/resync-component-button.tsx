"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { resyncComponentMetadata, startComponentResyncBranch } from "./actions";
import { finishCodeGenSession } from "../../settings/codegen-actions";

type ResyncState = "idle" | "running" | "done" | "error";

/**
 * "Resync this component" on the component detail page: re-fetches this
 * component's Figma node and diffs its variant children against what's
 * stored (src/lib/figma/sync.ts's resyncComponentFromFigma), then -- if
 * code generation is on for this workspace -- regenerates just this
 * component's code via the SAME per-component route the full "Generate
 * code" flow uses (design-system-codegen-panel.tsx), landing the commit
 * on the workspace's currently-open PR branch if one exists rather than
 * opening a new one.
 */
export function ResyncComponentButton({ slug }: { slug: string }) {
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
      const meta = await resyncComponentMetadata(slug);
      if (!meta.ok) {
        setState("error");
        setMessage(meta.error ?? "Resync failed.");
        return;
      }

      if (!meta.codeSyncEnabled) {
        setState("done");
        setMessage(meta.summary ?? "Metadata refreshed.");
        router.refresh();
        return;
      }

      const { branchName } = await startComponentResyncBranch();
      const res = await fetch(
        `/api/design-system/codegen/${encodeURIComponent(slug)}?branch=${encodeURIComponent(branchName)}`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setState("error");
        setMessage(`${meta.summary ? `${meta.summary} -- ` : ""}code generation failed: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }

      const { prUrl: openedPrUrl } = await finishCodeGenSession(branchName);
      setState("done");
      setMessage(meta.summary ?? "Resynced.");
      setPrUrl(openedPrUrl);
      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [state, slug, router]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        className="self-start rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "running" ? "Resyncing..." : "Resync this component"}
      </button>

      {message && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            state === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
          }`}
        >
          {message}
        </p>
      )}

      {prUrl && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Committed to{" "}
          <a href={prUrl} target="_blank" rel="noreferrer" className="underline">
            pull request
          </a>{" "}
          -- review it, then confirm in Settings.
        </p>
      )}
    </div>
  );
}
