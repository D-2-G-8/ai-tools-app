// Pure types for the codegen review layer. No server-only, no imports from
// component.ts -- so review/deterministic.ts stays importable under plain node
// for fixture tests. Mirrors the 4 files a component generates.

export type FileKind = "tsx" | "css" | "stories" | "index";

/** The four generated source contents, keyed by kind (the review layer's unit
 *  of work). Adapts to/from GeneratedComponentFiles in component.ts. */
export interface GeneratedFiles {
  tsx: string;
  css: string;
  stories: string;
  index: string;
}

export type Severity = "build-breaking" | "quality";

export interface Finding {
  /** Stable slug for the rule, e.g. "stories-self-import-case". */
  id: string;
  severity: Severity;
  file: FileKind;
  message: string;
  /** Optional concrete fix hint fed to the LLM autofix. */
  suggestion?: string;
}

/** Everything the deterministic gates need, derived purely from the slug + the
 *  workspace's synced tokens. */
export interface ReviewContext {
  /** componentIdentifier(slug) -- the exported identifier + file base. */
  componentName: string;
  /** The file base name (currently == componentName). */
  fileBase: string;
  /** Sanitized CSS var names (toCssVarName(token.name)) of every synced token,
   *  for verifying var(--x) references resolve. */
  tokenVarNames: Set<string>;
}

export interface ReviewResult {
  files: GeneratedFiles;
  /** Residual (still-unfixed) findings after the loop. */
  findings: Finding[];
  /** True iff no build-breaking finding remains (safe to commit). */
  passed: boolean;
  iterations: number;
}
