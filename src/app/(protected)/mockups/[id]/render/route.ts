import { notFound } from "next/navigation";
import { loadMockupForWorkspace } from "../../shared";

export const dynamic = "force-dynamic";

/**
 * Serves a mockup's raw HTML inline (no Content-Disposition) so it can be
 * embedded in an <iframe> for live preview — see the mockup view page.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await loadMockupForWorkspace(id);
  if (!m) notFound();
  if (!m.blobUrl) notFound(); // a Figma reference mockup has a screenshot, not inline HTML

  let res: Response;
  try {
    res = await fetch(m.blobUrl, { cache: "no-store" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Couldn't load the mockup: ${message}`, { status: 502 });
  }
  if (!res.ok) {
    return new Response(`Couldn't load the mockup (${res.status})`, { status: 502 });
  }

  const body = await res.arrayBuffer();
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
