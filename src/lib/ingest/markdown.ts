import matter from "gray-matter";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  title: string | null;
  content: string;
}

export interface MarkdownChunk {
  chunkIndex: number;
  headingPath: string | null;
  content: string;
}

interface Section {
  headingPath: string | null;
  lines: string[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^(```|~~~)/;

/** Extracts the frontmatter and the first heading as the title. */
export function parseMarkdown(raw: string): ParsedMarkdown {
  const { data, content } = matter(raw);
  const titleFromFrontmatter =
    typeof data.title === "string" && data.title.trim().length > 0 ? data.title.trim() : null;

  let titleFromHeading: string | null = null;
  for (const line of content.split("\n")) {
    const m = HEADING_RE.exec(line.trim());
    if (m) {
      titleFromHeading = m[2].trim();
      break;
    }
  }

  return {
    frontmatter: data,
    title: titleFromFrontmatter ?? titleFromHeading,
    content,
  };
}

/**
 * Splits markdown into sections by headings, without confusing a '#' inside
 * code blocks with real headings.
 */
function splitIntoSections(content: string): Section[] {
  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let current: Section = { headingPath: null, lines: [] };
  let insideFence = false;

  const flush = () => {
    if (current.lines.some((l) => l.trim().length > 0)) {
      sections.push(current);
    }
  };

  for (const line of content.split("\n")) {
    if (FENCE_RE.test(line.trim())) {
      insideFence = !insideFence;
      current.lines.push(line);
      continue;
    }

    if (!insideFence) {
      const m = HEADING_RE.exec(line);
      if (m) {
        flush();
        const level = m[1].length;
        const text = m[2].trim();
        while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, text });
        current = {
          headingPath: headingStack.map((h) => h.text).join(" > "),
          lines: [line],
        };
        continue;
      }
    }

    current.lines.push(line);
  }
  flush();

  return sections;
}

/**
 * Within a section, splits the text into "units" — paragraphs, while a code
 * block or a markdown table always stays a single indivisible unit, so that a
 * chunk cannot break them in the middle.
 */
function splitSectionIntoUnits(lines: string[]): string[] {
  const units: string[] = [];
  let buffer: string[] = [];
  let insideFence = false;
  let insideTable = false;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) units.push(text);
    buffer = [];
  };

  for (const line of lines) {
    const isFenceLine = FENCE_RE.test(line.trim());
    const isTableLine = /^\s*\|/.test(line);

    if (isFenceLine) {
      if (!insideFence) {
        // start of a code block — close the previous text paragraph
        if (!insideTable) flush();
        insideFence = true;
      } else {
        buffer.push(line);
        insideFence = false;
        flush();
        continue;
      }
      buffer.push(line);
      continue;
    }

    if (insideFence) {
      buffer.push(line);
      continue;
    }

    if (isTableLine) {
      insideTable = true;
      buffer.push(line);
      continue;
    }
    if (insideTable && line.trim() === "") {
      insideTable = false;
      flush();
      continue;
    }
    if (insideTable) {
      buffer.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    buffer.push(line);
  }
  flush();

  return units;
}

const DEFAULT_MAX_CHARS = 3200; // ~700-800 tokens
const DEFAULT_OVERLAP_CHARS = 200;

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/** Main function: markdown -> list of chunks with heading path, ready for embedding. */
export function chunkMarkdown(raw: string, options: ChunkOptions = {}): MarkdownChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const { content } = parseMarkdown(raw);
  const sections = splitIntoSections(content);

  const chunks: MarkdownChunk[] = [];

  for (const section of sections) {
    const units = splitSectionIntoUnits(section.lines);
    let current = "";

    const pushChunk = () => {
      const text = current.trim();
      if (text.length === 0) return;
      chunks.push({
        chunkIndex: chunks.length,
        headingPath: section.headingPath,
        content: text,
      });
    };

    for (const unit of units) {
      // The unit itself exceeds the limit (e.g. a long code block) — store it as a separate chunk.
      if (unit.length > maxChars) {
        pushChunk();
        current = "";
        chunks.push({ chunkIndex: chunks.length, headingPath: section.headingPath, content: unit });
        continue;
      }

      if (current.length + unit.length + 2 > maxChars) {
        pushChunk();
        // a small overlap for context continuity between adjacent chunks
        const tail = current.slice(-overlapChars);
        current = tail ? `${tail}\n\n${unit}` : unit;
      } else {
        current = current ? `${current}\n\n${unit}` : unit;
      }
    }
    pushChunk();
  }

  // Renumber in order across the whole document.
  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}
