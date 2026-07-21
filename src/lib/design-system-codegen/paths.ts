/**
 * Pure (no server-only, no I/O, no LLM) helpers shared by the design-system
 * codegen: slug -> identifier/filename/path derivation, the generated-file
 * shape, and the Storybook story id. Split out of component.ts so the icon
 * pipeline (icon.ts) and unit tests can reuse them WITHOUT dragging in
 * component.ts's server-only + `ai`/`zod`/db imports. component.ts re-exports
 * everything here, so existing `from ".../component"` import sites are unchanged.
 */

export interface GeneratedComponentFiles {
  componentName: string;
  /** Paths relative to the design-system repo root. */
  tsxPath: string;
  tsxContent: string;
  cssPath: string;
  cssContent: string;
  storiesPath: string;
  storiesContent: string;
  indexPath: string;
  indexContent: string;
  /** Stale files to delete in the same commit -- e.g. a digit-leading slug that
   *  previously filed under its (invalid-identifier) pascalCase name and now
   *  files under the "N"-prefixed one; removing the old ones avoids orphaned
   *  duplicate files/stories breaking the build. Empty in the common case. */
  deletePaths: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function pascalCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * A VALID JS/React identifier for a slug. pascalCase alone can start with a
 * digit (slug "24-outline-orders" -> "24OutlineOrders"), which is a legal
 * FILENAME but an ILLEGAL identifier -- it breaks `export const`, `interface`,
 * and every `import { ... }` of it (confirmed: a "24-outline-orders" icon that
 * an accordion composed broke the whole design-system build). Prefix an "N" in
 * that case. A LETTER (not "_") so the Storybook story id derived from it stays
 * a plain lowercase of the same string. File paths keep pascalCase (valid as a
 * path), so identifier and filename can differ only for digit-leading slugs --
 * and regeneration then fixes files in place rather than orphaning renamed ones.
 */
export function componentIdentifier(slug: string): string {
  const name = pascalCase(slug);
  return /^[0-9]/.test(name) ? `N${name}` : name;
}

export interface ComponentSourcePaths {
  dir: string;
  componentName: string;
  tsxPath: string;
  cssPath: string;
  storiesPath: string;
  indexPath: string;
}

/**
 * The exact repo-relative paths a component's generated files live at,
 * derived purely from its slug and its isIcon flag. Single source of truth for
 * both writing those paths and deleting them (components/actions.ts,
 * settings/cleanup-actions.ts's "remove code-synced component(s)" flow) -- so a
 * rename of this convention can't silently desync the two.
 *
 * Icons (isIcon) live under `src/icons/<slug>/`, everything else under
 * `src/components/<slug>/`. Callers MUST pass the component's own isIcon so
 * writes and deletes always target the same folder.
 */
export function componentSourcePaths(slug: string, isIcon: boolean): ComponentSourcePaths {
  // File name == the exported identifier, so imports never have to juggle two
  // different names (a digit-leading slug files as "N24OutlineOrders.tsx", not
  // "24OutlineOrders.tsx" -- keeps every self/story/composition import a single
  // consistent name the model can't get wrong).
  const componentName = componentIdentifier(slug);
  const dir = `src/${isIcon ? "icons" : "components"}/${slug}`;
  return {
    dir,
    componentName,
    tsxPath: `${dir}/${componentName}.tsx`,
    cssPath: `${dir}/${componentName}.module.scss`,
    storiesPath: `${dir}/${componentName}.stories.tsx`,
    indexPath: `${dir}/index.ts`,
  };
}

/**
 * The Storybook story id ("components-<name>--default" / "icons-<name>--default")
 * the generated .stories.tsx uses for its canonical "Default" story. Storybook
 * derives a story id by lowercasing each "/"-separated title segment and
 * stripping everything outside [a-z0-9-_]; since componentIdentifier is
 * PascalCase with no separators, that's just its lowercase. Used by the
 * component detail page to embed the right Storybook iframe.
 */
export function storybookDefaultStoryId(slug: string, isIcon: boolean): string {
  const sanitizedComponentName = componentIdentifier(slug).toLowerCase();
  return `${isIcon ? "icons" : "components"}-${sanitizedComponentName}--default`;
}
