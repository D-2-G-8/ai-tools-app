"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { computeClosurePlan, startCodeGenSession, finishCodeGenSession } from "../../settings/codegen-actions";

type Status = "waiting" | "running" | "done" | "error";
interface Line {
  slug: string;
  status: Status;
  message?: string;
}

const CONCURRENCY = 4;

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runner() {
    while (next < items.length) await worker(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

const STATUS_CLASS: Record<Status, string> = {
  waiting: "text-neutral-400",
  running: "text-blue-600",
  done: "text-green-600",
  error: "text-red-600",
};

/**
 * Generates one chosen component together with its whole dependency closure
 * (everything it composes, transitively), in dependency order -- so picking
 * Avatar generates IconButton/BadgeCount/the profile icon first, then Avatar,
 * which imports them. One PR for the whole set.
 */
export function GenerateWithDepsButton({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setPrUrl(null);
    setLines([]);

    try {
      const { levels, error: planError } = await computeClosurePlan(slug);
      setLines(levels.flat().map((s) => ({ slug: s, status: "waiting" as Status })));

      const { branchName } = await startCodeGenSession();

      const runOne = async (compSlug: string) => {
        setLines((prev) => prev.map((l) => (l.slug === compSlug ? { ...l, status: "running" } : l)));
        try {
          const res = await fetch(
            `/api/design-system/codegen/${encodeURIComponent(compSlug)}?branch=${encodeURIComponent(branchName)}`,
            { method: "POST" },
          );
          const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; componentName?: string };
          setLines((prev) =>
            prev.map((l) =>
              l.slug === compSlug
                ? !res.ok || !body.ok
                  ? { ...l, status: "error", message: body.error ?? `HTTP ${res.status}` }
                  : { ...l, status: "done", message: body.componentName }
                : l,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setLines((prev) => prev.map((l) => (l.slug === compSlug ? { ...l, status: "error", message } : l)));
        }
      };

      // Barrier between levels; dependencies (earlier levels) commit first.
      for (const level of levels) await runWithConcurrency(level, CONCURRENCY, runOne);

      const { prUrl: openedPrUrl } = await finishCodeGenSession(branchName);
      setPrUrl(openedPrUrl);
      if (planError) setError(`Dependency detection degraded (${planError}); generated what was resolvable.`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [running, slug, router]);

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={run}
        disabled={running}
        className="self-start rounded-md border border-neutral-800 bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? "Generating…" : `Generate ${name} + dependencies`}
      </button>

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs">
          {lines.map((line) => (
            <div key={line.slug} className="flex items-center gap-2">
              <span className={STATUS_CLASS[line.status]}>
                {line.status === "done" ? "✓" : line.status === "error" ? "✗" : line.status === "running" ? "…" : "·"}
              </span>
              <span className="text-neutral-700">{line.slug}</span>
              {line.message && <span className="text-neutral-400">{line.message}</span>}
            </div>
          ))}
        </div>
      )}

      {prUrl && (
        <a href={prUrl} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">
          Review the pull request →
        </a>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
