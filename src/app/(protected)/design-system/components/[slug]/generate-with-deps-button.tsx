"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { computeClosurePlan, startCodeGenSession, finishCodeGenSession } from "../../settings/codegen-actions";

type Status = "waiting" | "running" | "done" | "error" | "skipped" | "blocked";
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
  skipped: "text-neutral-400",
  blocked: "text-amber-600",
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
      const { levels, edges, committed, error: planError } = await computeClosurePlan(slug);
      // Already-built dependencies are shown as skipped up front -- regenerating
      // a component shouldn't rebuild its committed deps (that just burns tokens).
      const committedSet = new Set(committed);
      setLines(
        levels.flat().map((s) => ({
          slug: s,
          status: committedSet.has(s) ? ("skipped" as Status) : ("waiting" as Status),
          message: committedSet.has(s) ? "already built" : undefined,
        })),
      );

      const { branchName } = await startCodeGenSession();

      // A failed component blocks its dependents (skip them, no route call);
      // the level barrier guarantees a dep's result is known before its
      // dependents' level runs. Committed deps never enter these sets.
      const failed = new Set<string>();
      const blocked = new Set<string>();

      const runOne = async (compSlug: string) => {
        if (committedSet.has(compSlug)) return; // already built -- don't regenerate
        const deps = edges[compSlug] ?? [];
        const blocker = deps.find((d) => failed.has(d) || blocked.has(d));
        if (blocker) {
          blocked.add(compSlug);
          setLines((prev) =>
            prev.map((l) => (l.slug === compSlug ? { ...l, status: "blocked", message: `dependency "${blocker}" not built` } : l)),
          );
          return;
        }
        setLines((prev) => prev.map((l) => (l.slug === compSlug ? { ...l, status: "running" } : l)));
        try {
          const res = await fetch(
            `/api/design-system/codegen/${encodeURIComponent(compSlug)}?branch=${encodeURIComponent(branchName)}`,
            { method: "POST" },
          );
          const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; componentName?: string };
          if (!res.ok || !body.ok) {
            failed.add(compSlug);
            setLines((prev) =>
              prev.map((l) => (l.slug === compSlug ? { ...l, status: "error", message: body.error ?? `HTTP ${res.status}` } : l)),
            );
            return;
          }
          setLines((prev) =>
            prev.map((l) => (l.slug === compSlug ? { ...l, status: "done", message: body.componentName } : l)),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.add(compSlug);
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
                {line.status === "done"
                  ? "✓"
                  : line.status === "error"
                    ? "✗"
                    : line.status === "running"
                      ? "…"
                      : line.status === "skipped"
                        ? "»"
                        : line.status === "blocked"
                          ? "⊘"
                          : "·"}
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
