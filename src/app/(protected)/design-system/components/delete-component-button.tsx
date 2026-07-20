"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteComponent } from "./actions";

/**
 * Delete control for a design_component row -- used on both the
 * components list (tucked inside each card, not floating over it) and the
 * component detail page (inside the "Design system code" section, since
 * what deletion actually does depends on that status). A native confirm()
 * is enough here: this is a plain, person-initiated destructive click
 * inside the app itself, not something automation drives.
 *
 * Behavior branches on `codeSyncStatus`, matching actions.ts's
 * deleteComponent: if code has already been generated for this component,
 * deleting it also opens/updates a pull request removing its files from
 * the design-system repo (not merged automatically -- see that action's
 * doc comment), and the confirm text says so up front rather than
 * surprising anyone.
 */
export function DeleteComponentButton({
  slug,
  name,
  codeSyncStatus,
  redirectTo,
}: {
  slug: string;
  name: string;
  codeSyncStatus: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const isCodeSynced = codeSyncStatus === "committed";

  const onClick = useCallback(() => {
    const confirmText = isCodeSynced
      ? `Delete "${name}"? Code has already been generated for it in the design-system repo -- this will ` +
        "also open/update a pull request removing its files there (review & confirm in Settings, same as " +
        "generation -- nothing is removed from the repo's main branch automatically). If it's still in the " +
        "current Figma file, the next sync will recreate the platform record here (but not the repo code)."
      : `Delete "${name}"? This only removes it here -- if it's still in the current Figma file, the next ` +
        'sync will recreate it. See "Last synced" to check.';
    if (!window.confirm(confirmText)) return;

    setError(null);
    setPrUrl(null);
    startTransition(async () => {
      try {
        const result = await deleteComponent(slug);
        if (!result.ok) {
          setError(result.error ?? "Delete failed.");
          return;
        }
        if (result.prUrl) setPrUrl(result.prUrl);
        if (redirectTo) {
          router.push(redirectTo);
        } else {
          router.refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [slug, name, isCodeSynced, redirectTo, router]);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs text-neutral-400 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Deleting..." : "Delete"}
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
    </span>
  );
}
