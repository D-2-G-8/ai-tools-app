"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface IconListItem {
  slug: string;
  name: string;
}

/**
 * "Outline/Regular/Plus" -> category "Outline · Regular", label "Plus" --
 * mirrors the "/"-hierarchical naming isLikelyIconName (src/lib/figma/
 * sync.ts) uses to recognize these as icons in the first place, so the
 * same convention drives the grouping here. A name with no "/" (an icon
 * that only qualified via its Figma page name, not this naming scheme)
 * falls back to one flat "Icons" group.
 */
function splitIconName(name: string): { category: string; label: string } {
  const parts = name
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { category: "Icons", label: name };
  return { category: parts.slice(0, -1).join(" · "), label: parts[parts.length - 1] };
}

/**
 * Dense grid, not full cards -- icon libraries commonly run into the
 * hundreds, and this platform doesn't fetch the actual icon artwork from
 * Figma (only names/metadata, same as every other synced component), so
 * each tile shows a 2-letter placeholder rather than the real glyph.
 * Fetching real SVGs (Figma's image export endpoint, GET /v1/images/:key)
 * would be a solid follow-up for real visual previews here -- not done in
 * this pass.
 */
export function IconsGrid({ icons }: { icons: IconListItem[] }) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = new Map<string, { slug: string; name: string; label: string }[]>();
    for (const icon of icons) {
      if (q && !icon.name.toLowerCase().includes(q)) continue;
      const { category, label } = splitIconName(icon.name);
      const list = groups.get(category) ?? [];
      list.push({ ...icon, label });
      groups.set(category, list);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [icons, query]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{icons.length} icon(s)</p>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons…"
          className="w-64 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
        />
      </div>

      {grouped.length === 0 && <p className="text-sm text-neutral-400">No icons match &quot;{query}&quot;.</p>}

      {grouped.map(([category, items]) => (
        <section key={category} className="border-t border-neutral-100 pt-4">
          <h2 className="mb-3 text-sm font-medium text-neutral-600">
            {category} <span className="text-neutral-400">({items.length})</span>
          </h2>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
            {items.map((icon) => (
              <Link
                key={icon.slug}
                href={`/design-system/components/${icon.slug}`}
                title={icon.name}
                className="flex flex-col items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2 py-3 text-center hover:border-neutral-300 hover:bg-neutral-50"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded bg-neutral-100 text-xs font-medium text-neutral-500">
                  {icon.label.slice(0, 2).toUpperCase()}
                </span>
                <span className="line-clamp-2 text-[11px] text-neutral-500">{icon.label}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
