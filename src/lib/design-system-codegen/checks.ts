// Pure deterministic checks for generated component files -- no server-only,
// no db/ai imports -- so they can be imported from plain node (e.g. fixture
// tests, review/deterministic.ts) as well as from component.ts.

export interface ClassNameCheckResult {
  ok: boolean;
  missingClasses: string[];
}

/**
 * Every class name CSS Modules would expose as an export key from this
 * stylesheet -- i.e. every `.identifier` token appearing ANYWHERE in a
 * selector, not just ones written as their own standalone top-level rule.
 * Real CSS Modules tooling (css-loader, Vite, PostCSS) extracts a class
 * from any selector position: compound (`.toggle.checked`), combinator
 * (`.list .item`), comma-separated (`.a, .b`), pseudo-class (`.btn:hover`),
 * inside @media, etc.
 *
 * A previous version of this function only matched a class if it was the
 * FIRST token of a standalone top-level selector (`^\s*\.name\s*[,{:]`),
 * which produced false "missing class" failures for the very common,
 * idiomatic pattern of a boolean/state modifier written as a compound
 * selector -- e.g. `.toggle.checked { ... }` for a `checked` prop. This is
 * confirmed to have blocked real generations in production: Toggle
 * (checked/unchecked/size16/24/32), Checkbox (size16/24/multi/b2b),
 * InputText (10+ state modifiers: filled/blur/error/focus/readOnly/
 * disabled/etc.), Accordion (opened/themeLight/themeDark), AvatarGroup
 * (themeLight/themeDark), BadgeCount (square) -- every one of these is a
 * modifier class the model correctly defined as a compound selector, which
 * the old anchored regex simply never looked past the first class of.
 *
 * This scans only the selector portion of each rule (text between the
 * previous `}`/start and the next `{`), so declaration values are never
 * mistaken for classes -- and couldn't be even without that: a class match
 * requires a letter/underscore/hyphen immediately after the dot, which
 * already excludes decimals like the `.5` in `scale(1.5)` or `48.5em`.
 */
function extractDefinedClassNames(cssContent: string): Set<string> {
  const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set<string>();
  for (const m of withoutComments.matchAll(/([^{}]*)\{/g)) {
    for (const cm of m[1].matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)) defined.add(cm[1]);
  }
  return defined;
}

/**
 * Deterministic (no LLM) safety check: every `styles.<name>` the TSX
 * references must have a matching class defined somewhere in the generated
 * stylesheet (see extractDefinedClassNames). Catches the exact failure
 * mode two independently generated files are prone to (a class name that
 * doesn't match) before anything is committed -- see component.ts's top
 * comment.
 */
export function checkClassNamesMatch(tsxContent: string, cssContent: string): ClassNameCheckResult {
  const referenced = new Set<string>();
  for (const m of tsxContent.matchAll(/styles\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) referenced.add(m[1]);
  for (const m of tsxContent.matchAll(/styles\[["']([^"']+)["']\]/g)) referenced.add(m[1]);

  const defined = extractDefinedClassNames(cssContent);

  const missingClasses = [...referenced].filter((name) => !defined.has(name));
  return { ok: missingClasses.length === 0, missingClasses };
}

export interface StoriesCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Deterministic (no LLM) safety check for the generated .stories.tsx:
 * catches the "Duplicate declaration" Babel/react-docgen parse error that
 * breaks Storybook's build entirely (confirmed in production -- a
 * component named "Default" produced `import { Default } from
 * "./Default"` alongside the mandatory `export const Default: Story`,
 * two top-level bindings named `Default` in one module, which Storybook
 * refuses to even parse). generateStories's prompt now always instructs
 * an aliased import (`import { X as Component } from "./X"`) specifically
 * to avoid this -- not just for a component literally named "Default",
 * but any component whose name happens to match one of its own
 * variant/state stories (e.g. "Primary") -- but since that's an LLM
 * instruction, not a guarantee, this check catches it deterministically
 * before anything commits, same as checkClassNamesMatch above.
 */
export function checkStoriesNoNameCollision(storiesContent: string, componentName: string): StoriesCheckResult {
  const escaped = componentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bareImport = new RegExp(`import\\s*\\{\\s*${escaped}\\s*\\}\\s*from\\s*["']\\./${escaped}["']`);
  if (!bareImport.test(storiesContent)) return { ok: true };

  const exportedNames = new Set<string>();
  for (const m of storiesContent.matchAll(/export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) exportedNames.add(m[1]);

  if (exportedNames.has(componentName)) {
    return {
      ok: false,
      reason:
        `The stories file imports the component under its own bare name ("${componentName}") while also ` +
        `exporting a story called "${componentName}" -- two top-level bindings with the same identifier, ` +
        "which breaks the Storybook build's parse step entirely. Not committing.",
    };
  }
  return { ok: true };
}
