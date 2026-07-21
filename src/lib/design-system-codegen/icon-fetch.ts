import "server-only";
import { getFileImages } from "@/lib/figma/client";

/**
 * Fetches the real, exact SVG for an icon node from Figma's images API
 * (`format=svg`) and returns its markup, or null if Figma couldn't render that
 * node -- some nodes (e.g. a component-set container) return a null image URL,
 * in which case the codegen route falls back to the LLM pipeline rather than
 * failing the run. Kept separate from icon.ts (which is pure) so the SVG-> JSX
 * builders there stay importable/unit-testable without this server-only I/O.
 */
export async function fetchIconSvg(fileKey: string, nodeId: string, accessToken: string): Promise<string | null> {
  const images = await getFileImages(fileKey, [nodeId], accessToken, { format: "svg" });
  const url = images[nodeId];
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const svg = await res.text();
  return svg.includes("<svg") ? svg : null;
}
