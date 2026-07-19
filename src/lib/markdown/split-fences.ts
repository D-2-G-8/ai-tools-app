export type MarkdownSegment =
  | { type: "text"; content: string }
  | { type: "bpmn"; content: string }
  | { type: "mermaid"; content: string }
  | { type: "image"; alt: string; src: string };

const DIAGRAM_LANGUAGES = ["bpmn", "mermaid"] as const;
type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

const FENCE_SRC = "```(" + DIAGRAM_LANGUAGES.join("|") + ")[ \\t]*\\r?\\n([\\s\\S]*?)```[ \\t]*\\r?\\n?";
// Matches `![alt](src)`, with an optional `"title"` after the src (standard
// markdown image syntax) -- same shape as lib/ingest/images.ts uses for the
// ingest-time version of this, kept separate since this one needs to report
// match position/length for segment splitting rather than just alt+src.
const IMAGE_SRC = '!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)';

/**
 * Splits raw markdown into alternating segments of plain text, fenced code
 * blocks in one of DIAGRAM_LANGUAGES, and inline images, so a document
 * viewer can render each specially while leaving everything else as plain
 * text.
 *
 * Only fences opened with exactly one of DIAGRAM_LANGUAGES (case-insensitive,
 * optional trailing spaces/tabs before the newline) are treated specially --
 * any other fenced block (```ts, plain ```, etc.) stays inside a surrounding
 * "text" segment untouched, matching the document viewer's existing
 * behavior for markdown it doesn't otherwise render specially. As a known
 * limitation, an image reference that happens to appear as literal example
 * text inside one of those untouched fenced blocks would still be picked up
 * as a real image -- an acceptable edge case for how these documents are
 * actually written.
 */
export function splitMarkdownFences(markdown: string): MarkdownSegment[] {
  const combinedRe = new RegExp(`(?:${FENCE_SRC})|(?:${IMAGE_SRC})`, "gi");
  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRe.exec(markdown)) !== null) {
    const [fullMatch, fenceLang, fenceBody, imageAlt, imageSrc] = match;
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: markdown.slice(lastIndex, match.index) });
    }
    if (fenceLang !== undefined) {
      segments.push({ type: fenceLang.toLowerCase() as DiagramLanguage, content: fenceBody.trim() });
    } else {
      segments.push({ type: "image", alt: imageAlt, src: imageSrc });
    }
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
