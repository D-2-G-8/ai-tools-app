import { notFound } from "next/navigation";
import { loadDocumentForWorkspace } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Streams a document's current content back as a file download, with a
 * proper filename (the Blob URL itself has a random suffix and isn't
 * suitable to hand to the user directly) and a forced "Save as" instead of
 * navigating the browser to raw text. Content-Disposition sets both a plain
 * ASCII fallback and an RFC 5987 filename* so non-ASCII filenames (e.g.
 * Cyrillic, from files uploaded on the user's own machine) still come
 * through correctly in browsers that support it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await loadDocumentForWorkspace(id);
  if (!doc) notFound();

  let res: Response;
  try {
    res = await fetch(doc.blobUrl, { cache: "no-store" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Couldn't download the file: ${message}`, { status: 502 });
  }
  if (!res.ok) {
    return new Response(`Couldn't download the file (${res.status})`, { status: 502 });
  }

  const body = await res.arrayBuffer();
  const asciiFallback = doc.filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "Content-Length": String(body.byteLength),
    },
  });
}
