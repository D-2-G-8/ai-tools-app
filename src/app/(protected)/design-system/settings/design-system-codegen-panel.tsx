"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { startCodeGenSession, finishCodeGenSession } from "./codegen-actions";

export interface CodegenComponentSummary {
  slug: string;
  name: string;
  codeSyncStatus: string;
}

type ComponentStatus = "waiting" | "running" | "done" | "error";
type RunMode = "idle" | "all" | "failed";

interface ComponentLine {
  slug: string;
  name: string;
  status: ComponentStatus;
  message?: string;
}

const CONCURRENCY = 3;

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
}

/**
 * "Generate code" button + live per-component progress log. Not SSE (like
 * figma-sync-button.tsx's metadata sync) -- each component is its own
 * short-lived POST to /api/design-system/codegen/[slug] (see that route),
 * so a plain fetch loop with limited concurrency gives the same live-
 * progress UX without needing a stream per call.
 */
export function DesignSystemCodegenPanel({ components }: { components: CodegenComponentSummary[] }) {
  const router = useRouter();
  const [runMode, setRunMode] = useState<RunMode>("idle");
  const running = runMode !== "idle";
  const [lines, setLines] = useState<ComponentLine[]>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  // Components whose LAST generation attempt errored (see the codegen
  // route's catch block, which sets codeSyncStatus: "failed" and never
  // touches lastCodeSyncAt/lastCodeCommitSha -- so a previously-committed
  // component that later fails a re-generation still keeps its old code
  // live, this list is just "worth trying again"). Derived from `components`
  // (server props), which router.refresh() below keeps current after every
  // run -- no separate client-side bookkeeping needed.
  const failedComponents = components.filter((c) => c.codeSyncStatus === "failed");

  const runComponents = useCallback(
    async (items: CodegenComponentSummary[], mode: RunMode) => {
      if (running || items.length === 0) return;
      setRunMode(mode);
      setSessionError(null);
      setPrUrl(null);
      setLines(items.map((c) => ({ slug: c.slug, name: c.name, status: "waiting" })));

      try {
        const { branchName } = await startCodeGenSession();

        await runWithConcurrency(items, CONCURRENCY, async (component) => {
          setLines((prev) => prev.map((l) => (l.slug === component.slug ? { ...l, status: "running" } : l)));
          try {
            const res = await fetch(`/api/design-system/codegen/${encodeURIComponent(component.slug)}?branch=${encodeURIComponent(branchName)}`, {
              method: "POST",
            });
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; componentName?: string };
            if (!res.ok || !body.ok) {
              setLines((prev) =>
                prev.map((l) => (l.slug === component.slug ? { ...l, status: "error", message: body.error ?? `HTTP ${res.status}` } : l)),
              );
              return;
            }
            setLines((prev) =>
              prev.map((l) => (l.slug === component.slug ? { ...l, status: "done", message: body.componentName } : l)),
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setLines((prev) => prev.map((l) => (l.slug === component.slug ? { ...l, status: "error", message } : l)));
          }
        });

        const { prUrl: openedPrUrl } = await finishCodeGenSession(branchName);
        setPrUrl(openedPrUrl);
        router.refresh();
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunMode("idle");
      }
    },
    [running, router],
  );

  const start = useCallback(() => runComponents(components, "all"), [runComponents, components]);
  const retryFailed = useCallback(() => runComponents(failedComponents, "failed"), [runComponents, failedComponents]);

  const statusLabel: Record<ComponentStatus, string> = {
    waiting: "queued",
    running: "generating...",
    done: "done",
    error: "failed",
  };
  const statusClass: Record<ComponentStatus, string> = {
    waiting: "text-neutral-400",
    running: "text-neutral-600",
    done: "text-emerald-600",
    error: "text-red-600",
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={start}
          disabled={running || components.length === 0}
          className="self-start rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {runMode === "all" ? "Generating code..." : "Generate code"}
        </button>
        {failedComponents.length > 0 && (
          <button
            type="button"
            onClick={retryFailed}
            disabled={running}
            title={failedComponents.map((c) => c.name).join(", ")}
            className="self-start rounded-md border border-amber-300 bg-amber-50 px-4 py-1.5 text-sm text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {runMode === "failed" ? "Retrying failed..." : `Retry failed only (${failedComponents.length})`}
          </button>
        )}
      </div>
      {components.length === 0 && !running && (
        <p className="text-xs text-neutral-400">Sync components from Figma first, then generate their code.</p>
      )}

      {lines.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs">
          {lines.map((line) => (
            <div key={line.slug} className="flex items-center justify-between gap-3">
              <span className="text-neutral-700">{line.name}</span>
              <span className={statusClass[line.status]}>
                {statusLabel[line.status]}
                {line.status === "error" && line.message ? `: ${line.message}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {sessionError && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{sessionError}</p>}
      {prUrl && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Opened{" "}
          <a href={prUrl} target="_blank" rel="noreferrer" className="underline">
            pull request
          </a>{" "}
          -- review its CI status, then confirm below.
        </p>
      )}
    </div>
  );
}
