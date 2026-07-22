"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { CiTypecheckStatus } from "./codegen-actions";

type AutofixState = "idle" | "running" | "done" | "error";

interface CiAutofixResult {
  ok: boolean;
  status?: "green" | "fixed" | "pending" | "no-pr" | "escalate";
  fixed?: string[];
  skippedIcons?: string[];
  remaining?: number;
  errorCount?: number;
  error?: string;
}

const CONCLUSION_LABEL: Record<CiTypecheckStatus["conclusion"], string> = {
  success: "Typecheck passing",
  failure: "Typecheck failing",
  pending: "Typecheck running",
  missing: "Typecheck status unavailable",
  "no-pr": "No pull request open",
};

/**
 * Typecheck status card for the pending-PR section of Settings -- shows the
 * design-system CI's latest typecheck result for the open PR's branch, and
 * a button to run one round of the CI-typecheck-feedback autofix loop (see
 * /api/design-system/ci-autofix + src/lib/design-system-codegen/ci-autofix.ts).
 * Only meaningful once a PR exists, so this only ever renders alongside the
 * "pending PR" banner in page.tsx. Follows ResyncComponentsButton's
 * state/labels/markup conventions.
 */
export function CiTypecheckPanel({ status }: { status: CiTypecheckStatus }) {
  const router = useRouter();
  const [state, setState] = useState<AutofixState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);

  const runAutofix = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    setMessage(null);

    try {
      const res = await fetch("/api/design-system/ci-autofix", { method: "POST" });
      const result: CiAutofixResult = await res.json();

      if (!result.ok) {
        setState("error");
        setMessage(result.error ?? "Auto-fix failed.");
        return;
      }

      if (result.status === "escalate") {
        setState("error");
        setMessage("Auto-fix didn't converge after several rounds -- these need manual attention.");
      } else if (result.status === "green") {
        setState("done");
        setMessage("Typecheck is passing -- nothing to fix.");
      } else if (result.status === "pending") {
        setState("done");
        setMessage("CI is still running -- try again once it completes.");
      } else if (result.status === "no-pr") {
        setState("done");
        setMessage("No pull request open.");
      } else {
        const fixedCount = result.fixed?.length ?? 0;
        const skippedCount = result.skippedIcons?.length ?? 0;
        const remaining = result.remaining ?? 0;
        setState("done");
        setMessage(
          `Fixed ${fixedCount} component(s).` +
            (skippedCount > 0 ? ` Skipped ${skippedCount} icon(s) (needs manual attention).` : "") +
            (remaining > 0 ? ` ${remaining} still failing.` : ""),
        );
      }

      router.refresh();
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [state, router]);

  const canAutofix = status.conclusion === "failure";

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span
          className={`text-sm ${
            status.conclusion === "success"
              ? "text-emerald-700"
              : status.conclusion === "failure"
                ? "text-red-700"
                : "text-neutral-600"
          }`}
        >
          {CONCLUSION_LABEL[status.conclusion]}
          {status.conclusion === "failure" ? ` (${status.errorCount} error${status.errorCount === 1 ? "" : "s"})` : ""}
        </span>
        <button
          type="button"
          onClick={runAutofix}
          disabled={!canAutofix || state === "running"}
          className="shrink-0 rounded-md border border-neutral-300 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === "running" ? "Auto-fixing..." : "Auto-fix type errors"}
        </button>
      </div>

      {status.conclusion === "failure" && status.sample.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowSample((v) => !v)}
            className="text-xs text-neutral-500 underline hover:text-neutral-700"
          >
            {showSample ? "Hide errors" : `Show errors (${status.sample.length}${status.errorCount > status.sample.length ? "+" : ""})`}
          </button>
          {showSample && (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-neutral-600">
              {status.sample.map((line, i) => (
                <li key={i} className="rounded bg-white px-2 py-1 font-mono">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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
