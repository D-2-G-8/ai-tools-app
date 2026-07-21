import { checkClassNamesMatch, checkStoriesNoNameCollision } from "../checks";
import type { Finding, GeneratedFiles, ReviewContext } from "./types";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A1: the stories file must import the component as
 *  `import { <componentName> as Component } from "./<fileBase>"` with EXACT
 *  casing -- a case-sensitive build (Vercel/rollup) can't resolve `./BadgeCount`
 *  for a file named `Badgecount.tsx`, and the wrong named import doesn't exist. */
function gateStoriesSelfImport(files: GeneratedFiles, ctx: ReviewContext): Finding | null {
  const m = files.stories.match(
    /import\s*\{\s*([A-Za-z0-9_$]+)\s+as\s+Component\s*\}\s*from\s*["']\.\/([A-Za-z0-9_$]+)["']/,
  );
  if (!m) {
    return {
      id: "stories-self-import-missing",
      severity: "build-breaking",
      file: "stories",
      message: `Stories must import the component as: import { ${ctx.componentName} as Component } from "./${ctx.fileBase}"`,
    };
  }
  const [, name, path] = m;
  if (name !== ctx.componentName || path !== ctx.fileBase) {
    return {
      id: "stories-self-import-case",
      severity: "build-breaking",
      file: "stories",
      message: `Stories self-import uses "${name}" from "./${path}" but must be "${ctx.componentName}" from "./${ctx.fileBase}" (exact case -- case-sensitive build).`,
      suggestion: `import { ${ctx.componentName} as Component } from "./${ctx.fileBase}";`,
    };
  }
  return null;
}

/** A2: a lone `import React from "react"` with no `React.` reference is an
 *  unused import under the automatic JSX runtime (TS6133 breaks the build).
 *  The design-system uses the automatic runtime (confirmed: TS6133 fired on a
 *  generated icon), so JSX alone does not "use" React. */
function gateUnusedReactImport(content: string, file: "tsx" | "stories"): Finding | null {
  const hasImport = /(^|\n)\s*import\s+React\s+from\s+["']react["'];?/.test(content);
  if (!hasImport) return null;
  if (/\bReact\./.test(content)) return null;
  return {
    id: "unused-react-import",
    severity: "build-breaking",
    file,
    message: `import React is unused (automatic JSX runtime -> TS6133). Remove it, or reference React.<something>.`,
  };
}

/** A5: the tsx must export the exact `componentName` (index.ts + file name
 *  depend on it). Not auto-fixable (rename touches every reference) -> handed
 *  to the LLM autofix. */
function gateExportName(files: GeneratedFiles, ctx: ReviewContext): Finding | null {
  const re = new RegExp(`export\\s+(?:const|function)\\s+${escapeRegExp(ctx.componentName)}\\b`);
  if (re.test(files.tsx)) return null;
  return {
    id: "export-name-mismatch",
    severity: "build-breaking",
    file: "tsx",
    message: `The tsx must export the identifier "${ctx.componentName}" (matches index.ts and the file name). Rename the exported component to exactly "${ctx.componentName}".`,
  };
}

/** A6: every var(--x) the scss references must be a synced token, else it
 *  resolves to nothing at runtime. Not auto-fixable (need the right token) ->
 *  LLM autofix. */
function gateTokenVars(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const m of files.css.matchAll(/var\(\s*--([a-z0-9-]+)\s*\)/gi)) {
    const name = m[1].toLowerCase();
    if (seen.has(name) || ctx.tokenVarNames.has(name)) continue;
    seen.add(name);
    out.push({
      id: "unknown-token-var",
      severity: "build-breaking",
      file: "css",
      message: `var(--${name}) is not a synced design token. Use an existing token var, or an inline value from the design spec.`,
    });
  }
  return out;
}

export function runDeterministicGates(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  const findings: Finding[] = [];

  const selfImport = gateStoriesSelfImport(files, ctx);
  if (selfImport) findings.push(selfImport);

  const reactTsx = gateUnusedReactImport(files.tsx, "tsx");
  if (reactTsx) findings.push(reactTsx);
  const reactStories = gateUnusedReactImport(files.stories, "stories");
  if (reactStories) findings.push(reactStories);

  const exportName = gateExportName(files, ctx);
  if (exportName) findings.push(exportName);

  findings.push(...gateTokenVars(files, ctx));

  // A3: styles.<name> referenced in tsx must exist in the scss.
  const classCheck = checkClassNamesMatch(files.tsx, files.css);
  if (!classCheck.ok) {
    findings.push({
      id: "class-name-mismatch",
      severity: "build-breaking",
      file: "tsx",
      message: `tsx references CSS Modules classes not defined in the stylesheet: ${classCheck.missingClasses.join(", ")}.`,
    });
  }

  // A4: stories must not collide the component's bare import with a story name.
  const storiesCheck = checkStoriesNoNameCollision(files.stories, ctx.componentName);
  if (!storiesCheck.ok) {
    findings.push({
      id: "stories-name-collision",
      severity: "build-breaking",
      file: "stories",
      message: storiesCheck.reason ?? "Stories name collision.",
    });
  }

  return findings;
}

/** Applies only the deterministically-fixable findings (A1 casing, A2 unused
 *  React). Everything else is returned unchanged for the LLM autofix. Safe to
 *  call repeatedly. */
export function applyDeterministicFixes(files: GeneratedFiles, findings: Finding[]): GeneratedFiles {
  let { tsx, css, stories, index } = files;
  const ids = new Set(findings.map((f) => f.id));

  if (ids.has("stories-self-import-case") || ids.has("stories-self-import-missing")) {
    // Rebuild from the finding's suggestion is unnecessary; the correct line is
    // derivable, but we only have ctx via the finding suggestion. Rewrite any
    // `{ X as Component } from "./Y"` to the suggested canonical line.
    const sugg = findings.find(
      (f) => f.id === "stories-self-import-case" || f.id === "stories-self-import-missing",
    )?.suggestion;
    if (sugg) {
      stories = stories.replace(
        /import\s*\{\s*[A-Za-z0-9_$]+\s+as\s+Component\s*\}\s*from\s*["']\.\/[A-Za-z0-9_$]+["'];?/,
        sugg,
      );
    }
  }

  if (ids.has("unused-react-import")) {
    tsx = stripUnusedReactImport(tsx);
    stories = stripUnusedReactImport(stories);
  }

  return { tsx, css, stories, index };
}

function stripUnusedReactImport(content: string): string {
  if (/\bReact\./.test(content)) return content;
  return content.replace(/(^|\n)\s*import\s+React\s+from\s+["']react["'];?[ \t]*\n/, "$1");
}
