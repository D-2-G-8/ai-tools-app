"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface ClearActionResult {
  ok?: boolean;
  error?: string;
  /** Set when the action also had to remove code from the design-system repo. */
  prUrl?: string;
  deleted?: number;
}

/**
 * Bulk "clear" button for design-system/settings's Cleanup section -- for
 * when duplicate/stale rows have piled up (metadata sync is upsert-only
 * and never prunes anything, see delete-component-button.tsx's doc
 * comment) and sorting out individually what's garbage isn't worth it.
 * Generic over the action so it covers all four cleanup actions in
 * settings/cleanup-actions.ts: the metadata-only ones just delete rows
 * (result is `{ deleted }` or void), the code-synced ones also commit a
 * removal to the design-system repo and return `{ prUrl }` -- shown here
 * as a link rather than thrown, since it's a success outcome, not an
 * error, that's still worth surfacing (review & confirm in the banner
 * above once it's ready).
 */
export function ClearAllButton({
  action,
  label,
  confirmText,
}: {
  action: () => Promise<ClearActionResult | void>;
  label: string;
  confirmText: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          setError(null);
          setPrUrl(null);
          startTransition(async () => {
            try {
              const result = await action();
              if (result && result.ok === false) {
                setError(result.error ?? "Failed.");
                return;
              }
              if (result?.prUrl) setPrUrl(result.prUrl);
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          });
        }}
        disabled={pending}
        className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Clearing..." : label}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {prUrl && (
        <p className="text-xs text-neutral-500">
          Removed via{" "}
          <a href={prUrl} target="_blank" rel="noreferrer" className="underline">
            pull request
          </a>
          .
        </p>
      )}
    </div>
  );
}
