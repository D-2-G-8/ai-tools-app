"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DeleteComponentButton } from "./delete-component-button";
import { mergeComponents } from "./actions";

export interface ComponentListItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  variantsCount: number;
  statesCount: number;
  lastSyncedLabel: string;
  codeSyncStatus: string;
}

/**
 * The components grid, plus an opt-in "select to merge duplicates" mode --
 * for components sync doesn't recognize as identical (different literal
 * Figma names -- e.g. "Button Primary" / "Button Secondary" as separate
 * Figma components instead of variants of one shared "Button"; sync
 * itself only auto-merges EXACT name matches, see src/lib/figma/sync.ts's
 * buildComponentGroups doc comment). A client component (not a plain
 * <form> submit) so the selection count / merge button can update live
 * without a full page round-trip per checkbox.
 */
export function ComponentsGrid({ components }: { components: ComponentListItem[] }) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const onMerge = () => {
    if (selected.size < 2) return;
    const names = components
      .filter((c) => selected.has(c.slug))
      .map((c) => c.name)
      .join(", ");
    if (
      !window.confirm(
        `Merge ${selected.size} components (${names}) into one? Variants/states union (duplicates collapse, ` +
          "never repeated); the oldest-synced one survives with the combined data, the rest are deleted.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await mergeComponents(Array.from(selected));
      if (!result.ok) {
        setError(result.error ?? "Merge failed.");
        return;
      }
      setSelected(new Set());
      setSelectMode(false);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            setSelectMode((v) => !v);
            setSelected(new Set());
            setError(null);
          }}
          className="text-xs text-neutral-500 hover:underline"
        >
          {selectMode ? "Cancel" : "Select to merge duplicates"}
        </button>
        {selectMode && (
          <div className="flex items-center gap-3">
            {error && <span className="text-xs text-red-600">{error}</span>}
            <span className="text-xs text-neutral-400">{selected.size} selected</span>
            <button
              type="button"
              onClick={onMerge}
              disabled={selected.size < 2 || pending}
              className="rounded-md bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Merging..." : "Merge selected"}
            </button>
          </div>
        )}
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {components.map((component) => (
          <li
            key={component.id}
            className="rounded-lg border border-neutral-200 bg-white p-4 text-sm hover:border-neutral-300"
          >
            {selectMode && (
              <label className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={selected.has(component.slug)}
                  onChange={() => toggle(component.slug)}
                />
                Select
              </label>
            )}
            <Link href={`/design-system/components/${component.slug}`} className="block">
              <div className="font-medium">{component.name}</div>
              {component.description && (
                <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{component.description}</p>
              )}
              <div className="mt-2 text-xs text-neutral-400">
                {component.variantsCount} variants · {component.statesCount} states
              </div>
              <div className="mt-1 text-xs text-neutral-400">Last synced {component.lastSyncedLabel}</div>
            </Link>
            <div className="mt-2 flex items-center justify-between border-t border-neutral-100 pt-2">
              <span className="text-xs text-neutral-400">
                {component.codeSyncStatus === "committed" ? "In design-system repo" : "Metadata only"}
              </span>
              <DeleteComponentButton slug={component.slug} name={component.name} codeSyncStatus={component.codeSyncStatus} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
