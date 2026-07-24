import { notFound } from "next/navigation";
import { loadMockupForWorkspace } from "../../shared";

export const dynamic = "force-dynamic";

/** Same pattern as app/documents/[id]/download/route.ts — forces a "Save as" with a proper filename. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await loadMockupForWorkspace(id);
  if (!m) notFound();
  if (!m.blobUrl) notFound(); // a Figma reference mockup has no downloadable HTML file

  let res: Response;
  try {
    res = await fetch(m.blobUrl, { cache: "no-store" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Couldn't download the file: ${message}`, { status: 502 });
  }
  if (!res.ok) {
    return new Response(`Couldn't download the file (${res.status})`, { status: 502 });
  }

  const body = await res.arrayBuffer();
  const asciiFallback = m.filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");

  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
      "Content-Length": String(body.byteLength),
    },
  });
}
