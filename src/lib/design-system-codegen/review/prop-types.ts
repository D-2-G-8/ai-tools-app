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
    // bare boolean prop: `name` not followed by `=` (and not part of name=...)
    for (const m of attrs.matchAll(/(?:^|\s)([A-Za-z_][\w]*)(?=\s|$)/g)) {
      const name = m[1];
      if (out.some((p) => p.name === name)) continue; // already captured with a value
      out.push({ name, value: { kind: "boolean", v: true } });
    }
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
    // top-level `name: value` pairs (depth-0 within body)
    for (const pm of body.matchAll(/(?:^|[,{]\s*|\s)([A-Za-z_][\w]*)\s*:\s*("(?:[^"]*)"|'(?:[^']*)'|true|false|[^,}\n]+)/g)) {
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
