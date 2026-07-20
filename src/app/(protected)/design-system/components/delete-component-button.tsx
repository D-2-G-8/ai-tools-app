"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteComponent } from "./actions";

/**
 * Delete button for a design_component row -- used on both the components
 * list (each card) and the component detail page. A native confirm() is
 * enough here: this is a plain, person-initiated destructive click inside
 * the app itself, not something automation drives.
 *
 * `stopNavigation`: the list page's cards are each wrapped in a full-card
 * <Link>, so this button is rendered on top of it -- without stopping the
 * click from bubbling/defaulting, "Delete" would also navigate to the
 * component page. The detail page doesn't need this (no enclosing link).
 */
export function DeleteComponentButton({
  slug,
  name,
  stopNavigation = false,
  redirectTo,
}: {
  slug: string;
  name: string;
  stopNavigation?: boolean;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (stopNavigation) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (
        !window.confirm(
          `Delete "${name}"? This only removes it here -- if it's still in the current Figma file, the next sync will recreate it. See "last synced" below to check.`,
        )
      ) {
        return;
      }
      setError(null);
      startTransition(async () => {
        try {
          await deleteComponent(slug);
          if (redirectTo) {
            router.push(redirectTo);
          } else {
            router.refresh();
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    },
    [slug, name, stopNavigation, redirectTo, router],
  );

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Deleting..." : "Delete"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </span>
  );
}
