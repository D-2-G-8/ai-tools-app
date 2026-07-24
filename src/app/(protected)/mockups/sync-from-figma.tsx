"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { syncMockupsFromFigmaAction } from "./actions";

type Result = Awaited<ReturnType<typeof syncMockupsFromFigmaAction>>;

/**
 * Imports existing app screens from Figma as reference mockups. Paste Figma
 * frame URLs (one per line), or leave empty to auto-discover screens from the
 * file's non-service pages. Designers keep doing complex work in Figma; this
 * pulls the current design in to ground AI mockup generation.
 */
export function SyncFromFigma() {
  const router = useRouter();
  const [urls, setUrls] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      const r = await syncMockupsFromFigmaAction(urls);
      setResult(r);
      router.refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={urls}
        onChange={(e) => setUrls(e.target.value)}
        rows={3}
        placeholder="Paste Figma URLs (one per line) — a screen or a whole flow board; boards are expanded to their individual screens"
        className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs"
      />
      <button
        onClick={run}
        disabled={running}
        className="self-start rounded-md border border-neutral-800 bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? "Syncing from Figma…" : "Sync mockups from Figma"}
      </button>

      {result && (
        <div className="text-xs">
          {result.error ? (
            <p className="text-red-600">{result.error}</p>
          ) : (
            <p className="text-neutral-600">
              Imported {result.imported}, removed {result.removed}
              {result.errors.length > 0 && `, ${result.errors.length} failed`}.
            </p>
          )}
          {result.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-red-600">
              {result.errors.map((e, i) => (
                <li key={i}>
                  {e.name}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
