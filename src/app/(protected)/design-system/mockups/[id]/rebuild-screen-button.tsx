"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { rebuildScreenOnDs } from "../actions";

/**
 * Rebuilds this Figma reference screen as a Storybook story composed from the
 * design-system components, and opens a PR in the design-system repo.
 */
export function RebuildScreenButton({ mockupId }: { mockupId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; prUrl?: string; error?: string } | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await rebuildScreenOnDs(mockupId);
      setResult(r);
      if (r.ok) router.refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={run}
        disabled={running}
        className="self-start rounded-md border border-neutral-800 bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? "Rebuilding on the design system…" : "Rebuild on design system (AI)"}
      </button>
      {result?.error && <p className="text-xs text-red-600">{result.error}</p>}
      {result?.ok && result.prUrl && (
        <a href={result.prUrl} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">
          Review the pull request →
        </a>
      )}
    </div>
  );
}
