// Pure mappers from CI tsc annotations to the affected design-system component.
// No server-only -- fixture-testable under tsx.
import type { TscAnnotation } from "@/lib/github/client";

export interface AffectedFile { slug: string; isIcon: boolean; file: "tsx" | "stories"; }

/** `src/components/<slug>/<X>.tsx|.stories.tsx` (or `src/icons/...`) -> the
 *  component it belongs to. The DIRECTORY name is the slug (see
 *  componentSourcePaths). Returns null for anything else (tokens, config, md). */
export function annotationToComponent(path: string): AffectedFile | null {
  const m = path.match(/^src\/(components|icons)\/([^/]+)\/[^/]+?\.(stories\.tsx|tsx)$/);
  if (!m) return null;
  return { slug: m[2], isIcon: m[1] === "icons", file: m[3] === "stories.tsx" ? "stories" : "tsx" };
}

export interface ComponentErrors {
  slug: string;
  isIcon: boolean;
  findings: { file: "tsx" | "stories"; message: string }[];
}

/** Group tsc annotations by component; drop annotations outside a component
 *  file. */
export function groupAnnotationsByComponent(annotations: TscAnnotation[]): ComponentErrors[] {
  const bySlug = new Map<string, ComponentErrors>();
  for (const a of annotations) {
    const c = annotationToComponent(a.path);
    if (!c) continue;
    let entry = bySlug.get(c.slug);
    if (!entry) {
      entry = { slug: c.slug, isIcon: c.isIcon, findings: [] };
      bySlug.set(c.slug, entry);
    }
    entry.findings.push({ file: c.file, message: a.message });
  }
  return [...bySlug.values()];
}

/** Last path segment of a `../`-style composition import (`../badgecount` ->
 *  "badgecount", `../../icons/fill-edit` -> "fill-edit"); null for non-`../`. */
export function importSlug(path: string): string | null {
  if (!path.startsWith("../")) return null;
  const seg = path.split("/").pop();
  return seg || null;
}
