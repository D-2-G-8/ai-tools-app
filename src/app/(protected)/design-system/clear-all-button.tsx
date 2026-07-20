"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Bulk "clear everything" button for the tokens/components pages -- for
 * when duplicate/stale rows have piled up (metadata sync is upsert-only
 * and never prunes anything, see delete-component-button.tsx's doc
 * comment) and sorting out individually what's garbage isn't worth it.
 * Deletes ALL rows of that kind for the workspace; run a sync afterwards
 * to repopulate whatever still genuinely exists in the current Figma
 * file.
 */
export function ClearAllButton({
  action,
  label,
  confirmText,
}: {
  action: () => Promise<void>;
  label: string;
  confirmText: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          setError(null);
          startTransition(async () => {
            try {
              await action();
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
    </div>
  );
}
