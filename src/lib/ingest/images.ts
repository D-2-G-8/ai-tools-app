import { describeImage } from "./image-caption";

export interface MarkdownImageRef {
  alt: string;
  src: string;
  /** The full `![alt](src)` match, used to splice the description back in. */
  fullMatch: string;
}

// Same alternation used by lib/markdown/split-fences.ts for the viewer side --
// kept as a separate (simpler) regex here since ingest only needs alt+src,
// not segment boundaries.
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Finds every markdown image reference (`![alt](src)`) in raw text. */
export function findMarkdownImages(markdown: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  let match: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((match = IMAGE_RE.exec(markdown)) !== null) {
    const [fullMatch, alt, src] = match;
    refs.push({ alt, src, fullMatch });
  }
  return refs;
}

// Anthropic's vision input only accepts these raster formats -- anything else
// (most commonly SVG, which isn't a raster format at all) is skipped for
// captioning. The image still displays fine in the document viewer either
// way; it just won't be described for the vector index.
const SUPPORTED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

export interface FetchedImage {
  data: string; // base64
  mediaType: string;
}

/**
 * Resolves an `![alt](src)` reference's `src` to base64 bytes + media type --
 * either decoding an inline `data:` URL directly, or downloading an
 * `http(s)://` URL (e.g. a Vercel Blob URL from an image inserted while
 * editing, see documents/image-actions.ts). Relative paths aren't
 * resolvable (there's no accompanying file bundle for uploaded .md files)
 * and are skipped. Returns null for anything unsupported or unreachable --
 * this is a "best effort" step, never a hard requirement for ingest to
 * succeed.
 */
export async function fetchImageAsBase64(src: string): Promise<FetchedImage | null> {
  const dataMatch = DATA_URL_RE.exec(src);
  if (dataMatch) {
    const [, mediaType, isBase64, payload] = dataMatch;
    if (!isBase64) return null; // percent-encoded data URLs are not worth supporting here
    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) return null;
    return { data: payload, mediaType };
  }

  if (!/^https?:\/\//i.test(src)) return null;

  const res = await fetch(src);
  if (!res.ok) return null;
  const mediaType = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mediaType };
}

// Keeps a single ingest bounded in cost and time (each image is one
// sequential vision-model call) -- see README "Known limitations". Images
// past this count still display fine when viewing the document; they're
// just not described for search.
const MAX_IMAGES_PER_DOCUMENT = 10;

/**
 * Builds a version of the markdown augmented with a text description right
 * after each embedded image, for chunking/embedding purposes ONLY -- this
 * augmented text is never written back to the document's stored Blob (the
 * document viewer still renders the original image), it just makes the
 * image's content findable via RAG search.
 *
 * Never throws: a document with no images, an unreachable image, or a
 * missing/invalid LLM token all fall back to returning the markdown
 * unchanged rather than failing the whole ingest over an image.
 */
export async function describeImagesInMarkdown(markdown: string): Promise<string> {
  const images = findMarkdownImages(markdown);
  if (images.length === 0) return markdown;

  const limited = images.slice(0, MAX_IMAGES_PER_DOCUMENT);
  if (images.length > limited.length) {
    console.warn(
      `Document has ${images.length} embedded images; only the first ${limited.length} are described for search.`,
    );
  }

  // Sequential on purpose -- mirrors embed.ts's reasoning for batching
  // Voyage calls: keeps this simple and avoids tripping rate limits on the
  // vision model by firing several requests for one document at once.
  const descriptions = new Map<string, string>(); // fullMatch -> description
  for (const img of limited) {
    if (descriptions.has(img.fullMatch)) continue; // same image referenced twice
    try {
      const fetched = await fetchImageAsBase64(img.src);
      if (!fetched) continue;
      const description = await describeImage({ data: fetched.data, mediaType: fetched.mediaType, alt: img.alt });
      if (description) descriptions.set(img.fullMatch, description);
    } catch (err) {
      // One bad/unreachable image or a captioning failure must not fail the
      // whole document ingest -- it just doesn't get indexed for search.
      console.error("Failed to describe an embedded image during ingest:", err);
    }
  }

  if (descriptions.size === 0) return markdown;

  let augmented = markdown;
  for (const [fullMatch, description] of descriptions) {
    augmented = augmented.split(fullMatch).join(`${fullMatch}\n\n[Image content, converted to text for search]\n${description}\n`);
  }
  return augmented;
}
