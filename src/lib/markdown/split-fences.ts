export type MarkdownSegment =
  | { type: "text"; content: string }
  | { type: "bpmn"; content: string };

/**
 * Splits raw markdown into alternating segments of plain text and ```bpmn
 * fenced code blocks, so a document viewer can render BPMN blocks as
 * diagrams while leaving everything else as plain text.
 *
 * Only fences opened with exactly ```bpmn (case-insensitive, optional
 * trailing spaces/tabs before the newline) are treated specially — any
 * other fenced block (```ts, plain ```, etc.) stays inside a surrounding
 * "text" segment untouched, matching the document viewer's existing
 * behavior for markdown it doesn't otherwise render specially.
 */
export function splitMarkdownFences(markdown: string): MarkdownSegment[] {
  const fenceRe = /```bpmn[ \t]*\r?\n([\s\S]*?)```[ \t]*\r?\n?/gi;
  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(markdown)) !== null) {
    const [fullMatch, body] = match;
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: markdown.slice(lastIndex, match.index) });
    }
    segments.push({ type: "bpmn", content: body.trim() });
    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ type: "text", content: markdown.slice(lastIndex) });
  }

  // Nothing matched at all -- keep it simple for callers, still one segment.
  if (segments.length === 0) {
    segments.push({ type: "text", content: markdown });
  }

  return segments;
}
