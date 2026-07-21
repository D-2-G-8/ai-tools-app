import { checkClassNamesMatch, checkStoriesNoNameCollision } from "../checks";
import { parseJsxLiteralProps, parseStoriesArgs, type LiteralValue, type PropDomain, type ParsedProp } from "./prop-types";
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

/** A1b: the tsx must import its stylesheet as `./<fileBase>.module.scss` with
 *  EXACT casing -- a case-sensitive build (Vercel/rollup) can't resolve
 *  `./BadgeCount.module.scss` for a file named `Badgecount.module.scss`.
 *  Deterministically fixable. */
function gateScssImport(files: GeneratedFiles, ctx: ReviewContext): Finding | null {
  const m = files.tsx.match(/from\s*["'](\.\/[A-Za-z0-9_$]+\.module\.scss)["']/);
  if (!m) return null; // no local scss import -- not this gate's job to force one
  const correct = `./${ctx.fileBase}.module.scss`;
  if (m[1] !== correct) {
    return {
      id: "scss-import-case",
      severity: "build-breaking",
      file: "tsx",
      message: `tsx imports its stylesheet as "${m[1]}" but the file is "${correct}" (exact case -- a case-sensitive build can't resolve it).`,
      suggestion: correct,
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
  const n = escapeRegExp(ctx.componentName);
  const direct = new RegExp(`export\\s+(?:const|function)\\s+${n}\\b`);
  const named = new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`);
  if (direct.test(files.tsx) || named.test(files.tsx)) return null;
  return {
    id: "export-name-mismatch",
    severity: "build-breaking",
    file: "tsx",
    message: `The tsx must export the identifier "${ctx.componentName}" (matches index.ts and the file name). Rename the exported component to exactly "${ctx.componentName}".`,
  };
}

/** A6: every var(--x) the scss references must resolve -- either a synced token
 *  OR a custom property the same stylesheet defines locally (`--x: ...`). Also
 *  tolerates a var() fallback (`var(--x, 8px)`). Unresolved ones are
 *  build-breaking (they render as nothing). */
function gateTokenVars(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  // Custom properties DEFINED in this stylesheet (`--x:`), which are local and
  // always resolve regardless of the token set.
  const localDefs = new Set<string>();
  for (const m of files.css.matchAll(/(?:^|[^-\w])--([a-z0-9-]+)\s*:/gi)) {
    localDefs.add(m[1].toLowerCase());
  }
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const m of files.css.matchAll(/var\(\s*--([a-z0-9-]+)\s*(?:,[^)]*)?\)/gi)) {
    const name = m[1].toLowerCase();
    if (seen.has(name) || ctx.tokenVarNames.has(name) || localDefs.has(name)) continue;
    seen.add(name);
    out.push({
      id: "unknown-token-var",
      severity: "build-breaking",
      file: "css",
      message: `var(--${name}) is neither a synced design token nor a custom property defined in this stylesheet. Use an existing token var, define it locally, or use an inline value.`,
    });
  }
  return out;
}

/** Returns a human problem string if `value` violates `domain`, else null.
 *  Only literal string/boolean values against finite domains are judged; expr
 *  and open domains never produce a violation. */
function domainViolation(value: LiteralValue, domain: PropDomain): string | null {
  if (value.kind === "expr" || domain.kind === "open") return null;
  if (domain.kind === "literals") {
    if (value.kind === "boolean") return `boolean ${value.v} is not one of ${[...domain.values].map((v) => `"${v}"`).join(", ")}`;
    if (!domain.values.has(value.v)) return `"${value.v}" is not one of ${[...domain.values].map((v) => `"${v}"`).join(", ")}`;
    return null;
  }
  // domain.kind === "boolean"
  if (value.kind === "string") return `"${value.v}" is a string but the prop is boolean`;
  return null;
}

/** A7a: every literal value in the STORIES (args objects + <Component ...> JSX)
 *  must be a member of the component's OWN prop domain. Catches e.g. a story
 *  passing size="24 px" when the union is "24px"|"40px". */
function gateSelfPropValues(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  if (ctx.ownProps.size === 0) return [];
  const out: Finding[] = [];
  const props: ParsedProp[] = [
    ...parseStoriesArgs(files.stories),
    // Generated stories always render the component under its `Component`
    // alias (`import { X as Component } from "./X"`, `<Component ...>`) --
    // never under ctx.componentName -- so the JSX scan must look for the
    // literal tag "Component", not the real component name.
    ...parseJsxLiteralProps(files.stories, "Component"),
  ];
  for (const p of props) {
    const domain = ctx.ownProps.get(p.name);
    if (!domain) continue;
    const v = domainViolation(p.value, domain);
    if (v) {
      out.push({
        id: "self-prop-value",
        severity: "build-breaking",
        file: "stories",
        message: `Stories set ${ctx.componentName}.${p.name} to a value that isn't in its type: ${v}. Use a valid value.`,
      });
    }
  }
  return out;
}

/** A7b: every literal value passed to a COMPOSED child in the tsx (<Child ...>)
 *  must be a member of that child's prop domain (from its stored contract).
 *  Catches e.g. <Badgecount appearance="Negative"> when the union is
 *  "negative"|"positive". Children without a stored contract are skipped. */
function gateComposedPropValues(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  const out: Finding[] = [];
  for (const [childId, domainMap] of ctx.composedProps) {
    for (const p of parseJsxLiteralProps(files.tsx, childId)) {
      const domain = domainMap.get(p.name);
      if (!domain) continue;
      const v = domainViolation(p.value, domain);
      if (v) {
        out.push({
          id: "composed-prop-value",
          severity: "build-breaking",
          file: "tsx",
          message: `<${childId}> is given ${p.name} that isn't in ${childId}'s type: ${v}. Convert the Figma label to a valid ${childId} prop value.`,
        });
      }
    }
  }
  return out;
}

export function runDeterministicGates(files: GeneratedFiles, ctx: ReviewContext): Finding[] {
  const findings: Finding[] = [];

  const selfImport = gateStoriesSelfImport(files, ctx);
  if (selfImport) findings.push(selfImport);

  const scssImport = gateScssImport(files, ctx);
  if (scssImport) findings.push(scssImport);

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

  findings.push(...gateSelfPropValues(files, ctx));
  findings.push(...gateComposedPropValues(files, ctx));

  return findings;
}

/** Applies only the deterministically-fixable findings (A1 casing, A2 unused
 *  React). Everything else is returned unchanged for the LLM autofix. Safe to
 *  call repeatedly. */
export function applyDeterministicFixes(files: GeneratedFiles, findings: Finding[]): GeneratedFiles {
  let { tsx, stories } = files;
  const { css, index } = files;
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

  if (ids.has("scss-import-case")) {
    const sugg = findings.find((f) => f.id === "scss-import-case")?.suggestion;
    if (sugg) tsx = tsx.replace(/(from\s*["'])\.\/[A-Za-z0-9_$]+\.module\.scss(["'])/, `$1${sugg}$2`);
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
