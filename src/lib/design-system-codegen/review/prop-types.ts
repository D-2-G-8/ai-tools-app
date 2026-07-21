// Pure parsers for the contract-aware value gates. No server-only, no imports
// from component.ts -- importable under plain tsx/node for fixture tests, like
// deterministic.ts. Turns contract `type` strings and JSX/args literals into
// comparable domains/values.

export type PropDomain =
  | { kind: "literals"; values: Set<string> }
  | { kind: "boolean" }
  | { kind: "open" };

export type LiteralValue =
  | { kind: "string"; v: string }
  | { kind: "boolean"; v: boolean }
  | { kind: "expr" };

export interface ParsedProp {
  name: string;
  value: LiteralValue;
}

/**
 * Parse a contract prop `type` string into a finite domain when we can PROVE
 * one, else `open` (never guess -- an unprovable type must not produce
 * findings). Splits the top-level union on `|` (literal unions don't contain a
 * bare `|`), drops `undefined`/`null` members, then:
 *  - all remaining members quoted string literals -> literals
 *  - remaining members are `boolean` / `true` / `false` only -> boolean
 *  - otherwise -> open
 */
export function parsePropType(type: string): PropDomain {
  const members = type
    .split("|")
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && m !== "undefined" && m !== "null");
  if (members.length === 0) return { kind: "open" };

  const asLiteral = (m: string): string | null => {
    const q = m.match(/^'([^']*)'$/) ?? m.match(/^"([^"]*)"$/);
    return q ? q[1] : null;
  };

  if (members.every((m) => asLiteral(m) !== null)) {
    return { kind: "literals", values: new Set(members.map((m) => asLiteral(m)!)) };
  }
  if (members.every((m) => m === "boolean" || m === "true" || m === "false")) {
    return { kind: "boolean" };
  }
  return { kind: "open" };
}

/** This component's own props -> value domain, for the self gate. Typed
 *  structurally (not `StoredComponentContract` from @/db/schema) so this
 *  module keeps no server-only-adjacent imports and stays importable under
 *  plain tsx/node for fixture tests, like the rest of this file. */
export function buildOwnProps(contract: { props: { name: string; type: string }[] }): Map<string, PropDomain> {
  const m = new Map<string, PropDomain>();
  for (const p of contract.props) m.set(p.name, parsePropType(p.type));
  return m;
}

/** Composed children's prop domains, keyed by JSX identifier (componentName).
 *  Skips any `uses` entry whose child has no stored contract. */
export function buildComposedProps(
  uses: { slug: string; componentName: string; isIcon: boolean }[] | undefined,
  childContracts: Map<string, { props: { name: string; type: string }[] }> | undefined,
): Map<string, Map<string, PropDomain>> {
  const out = new Map<string, Map<string, PropDomain>>();
  if (!uses || !childContracts) return out;
  for (const u of uses) {
    const c = childContracts.get(u.slug);
    if (!c) continue;
    const pm = new Map<string, PropDomain>();
    for (const p of c.props) pm.set(p.name, parsePropType(p.type));
    out.set(u.componentName, pm);
  }
  return out;
}

/** Extract the `<tag ...>` attribute substring for each occurrence, brace-aware
 *  so a `>` inside `{...}` doesn't truncate the tag. */
function tagAttrChunks(source: string, tag: string): string[] {
  const chunks: string[] = [];
  const re = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    let attrs = source.slice(m.index + m[0].length, end);
    if (attrs.endsWith("/")) attrs = attrs.slice(0, -1);
    chunks.push(attrs);
  }
  return chunks;
}

/** Scan a quoted string run starting at index `i` (where `s[i]` is the
 *  opening `"`/`'`). A quoted string is lexically atomic REGARDLESS of
 *  bracket-nesting depth -- callers must not let any character inside the
 *  run (including stray/unbalanced brackets) perturb their own depth
 *  counter. Returns the index just past the closing quote, or `s.length` if
 *  the string is unterminated. */
function scanQuotedRun(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== quote) j++;
  return j < s.length ? j + 1 : j; // include closing quote if present
}

/** Mask every brace-depth-aware `{...}` group and every quoted `"..."`/`'...'`
 *  string in `s` with spaces of equal length, leaving everything else (and
 *  the overall string length/positions) untouched. Used so the bare-boolean
 *  pass never sees identifiers that live inside an expression or a string --
 *  it only sees genuine standalone attribute names. Quote handling is
 *  depth-independent: a `"`/`'` opens a scan-to-matching-close at ANY depth
 *  (not just depth 0), so a stray `{`/`}` inside a nested quoted string never
 *  desyncs the depth counter. */
function maskBracesAndStrings(s: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = scanQuotedRun(s, i);
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "{") {
      depth++;
      out += " ";
      i++;
      continue;
    }
    if (c === "}") {
      depth = Math.max(0, depth - 1);
      out += " ";
      i++;
      continue;
    }
    if (depth > 0) {
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Literal attributes on `<tag ...>` occurrences. `p="s"`/`p={"s"}` -> string,
 *  `p={true}`/`p={false}` -> boolean, bare `p` -> boolean true, `p={other}` ->
 *  expr (skipped by the gate). */
export function parseJsxLiteralProps(source: string, tag: string): ParsedProp[] {
  const out: ParsedProp[] = [];
  for (const attrs of tagAttrChunks(source, tag)) {
    // name="v" | name='v'
    for (const m of attrs.matchAll(/(?:^|\s)([A-Za-z_][\w]*)=(?:"([^"]*)"|'([^']*)')/g)) {
      out.push({ name: m[1], value: { kind: "string", v: m[2] ?? m[3] ?? "" } });
    }
    // name={...}
    for (const m of attrs.matchAll(/(?:^|\s)([A-Za-z_][\w]*)=\{([^{}]*)\}/g)) {
      const inner = m[2].trim();
      const q = inner.match(/^'([^']*)'$/) ?? inner.match(/^"([^"]*)"$/);
      if (q) out.push({ name: m[1], value: { kind: "string", v: q[1] } });
      else if (inner === "true" || inner === "false")
        out.push({ name: m[1], value: { kind: "boolean", v: inner === "true" } });
      else out.push({ name: m[1], value: { kind: "expr" } });
    }
    // bare boolean prop: `name` not followed by `=` (and not part of name=...).
    // Run against a masked copy so identifiers inside `{...}` expressions or
    // quoted strings are never mistaken for standalone bare props.
    const masked = maskBracesAndStrings(attrs);
    for (const m of masked.matchAll(/(?:^|\s)([A-Za-z_][\w]*)(?=\s|$)/g)) {
      const name = m[1];
      if (out.some((p) => p.name === name)) continue; // already captured with a value
      out.push({ name, value: { kind: "boolean", v: true } });
    }
  }
  return out;
}

/** Mask every depth-aware `{...}`, `[...]`, and `(...)` group in `s` with
 *  spaces of equal length, leaving everything else (and the overall string
 *  length/positions) untouched. Quote-aware like `maskBracesAndStrings`, and
 *  depth-independent: a `"..."`/`'...'` run is scanned to its matching close
 *  at ANY depth (not just depth 0), so any `(`/`[`/`{` characters inside it
 *  never perturb depth tracking -- without this, an unbalanced bracket
 *  inside a nested string (e.g. `{ style: { note: "a[b" } }`) would desync
 *  the depth counter and silently drop every following top-level pair. At
 *  depth 0 the quoted run is copied verbatim (preserving a top-level string
 *  arg value for the `name: value` regex); at depth >= 1 it's masked to
 *  spaces like the rest of the nested group. Used so the top-level
 *  `name: value` pair regex never re-scans the inside of a nested
 *  object/array/call value as if it were more top-level pairs. */
function maskNestedGroups(s: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = scanQuotedRun(s, i);
      out += depth === 0 ? s.slice(i, end) : " ".repeat(end - i);
      i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      out += " ";
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth = Math.max(0, depth - 1);
      out += " ";
      i++;
      continue;
    }
    if (depth > 0) {
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Values inside every `args: { ... }` object literal (the Storybook surface TS
 *  type-checks). `name: "v"`/`'v'` -> string, `name: true/false` -> boolean,
 *  anything else -> expr. */
export function parseStoriesArgs(source: string): ParsedProp[] {
  const out: ParsedProp[] = [];
  const re = /\bargs\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length; // just past the `{`
    let depth = 1;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    const body = source.slice(start, i - 1);
    // Mask nested groups so a nested object/array/call's inner commas and
    // keys never get re-parsed as additional top-level pairs.
    const maskedBody = maskNestedGroups(body);
    // top-level `name: value` pairs (depth-0 within body)
    for (const pm of maskedBody.matchAll(/(?:^|[,{]\s*|\s)([A-Za-z_][\w]*)\s*:\s*("(?:[^"]*)"|'(?:[^']*)'|true|false|[^,}\n]+)/g)) {
      const name = pm[1];
      const raw = pm[2].trim();
      const q = raw.match(/^"([^"]*)"$/) ?? raw.match(/^'([^']*)'$/);
      if (q) out.push({ name, value: { kind: "string", v: q[1] } });
      else if (raw === "true" || raw === "false")
        out.push({ name, value: { kind: "boolean", v: raw === "true" } });
      else out.push({ name, value: { kind: "expr" } });
    }
  }
  return out;
}
