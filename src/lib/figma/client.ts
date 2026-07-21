import "server-only";
import { getSession } from "@/lib/session";
import { refreshFigmaToken } from "./oauth";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_FETCH_TIMEOUT_MS = 20_000;
// GET /v1/files/:key returns the full document tree -- for a large/complex
// file this can genuinely take much longer than a typical API call (Figma
// itself warns about this for big files). Used by src/lib/figma/sync.ts,
// which needs a longer allowance than the default above.
export const FIGMA_FILE_FETCH_TIMEOUT_MS = 55_000;
// Refresh a bit before the real 90-day expiry so a sync started right at
// the boundary doesn't fail mid-request.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Node/undici's fetch() throws a bare "fetch failed" on network-level
 * errors, same issue src/lib/gitlab/client.ts's describeGitlabError already
 * solved for GitLab -- reusing the same unwrapping logic here so Figma
 * errors are just as diagnosable.
 */
export function describeFigmaError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof AggregateError !== "undefined" && current instanceof AggregateError) {
      parts.push(...current.errors.map((e) => (e instanceof Error ? e.message : String(e))).filter((m) => !parts.includes(m)));
      break;
    }
    if (current instanceof Error) {
      if (!parts.includes(current.message)) parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" -- caused by: ");
}

/**
 * Returns a Figma access token valid for the signed-in user's session,
 * refreshing it first if it's expired or close to it. Returns null if
 * Figma isn't connected for this session at all (caller should treat that
 * as "not connected", not as an error).
 */
export async function getValidFigmaAccessToken(): Promise<string | null> {
  const session = await getSession();
  if (!session.figmaAccessToken) {
    // Local/CLI fallback: there's no browser OAuth session, but a personal
    // access token (figd_...) in the environment lets server-side code run
    // locally (e.g. testing the codegen route) still reach the Figma REST
    // API. In deployed/production runs this is unset and the session OAuth
    // token above is used.
    return process.env.FIGMA_ACCESS_TOKEN ?? null;
  }

  const expiresAt = session.figmaTokenExpiresAt ?? 0;
  if (Date.now() < expiresAt - REFRESH_SKEW_MS) {
    return session.figmaAccessToken;
  }

  if (!session.figmaRefreshToken) {
    // Expired with no way to refresh -- the caller's sync/UI should treat
    // this the same as "not connected" and prompt to reconnect.
    return null;
  }

  const refreshed = await refreshFigmaToken(session.figmaRefreshToken);
  session.figmaAccessToken = refreshed.access_token;
  session.figmaTokenExpiresAt = Date.now() + refreshed.expires_in * 1000;
  // Figma's refresh endpoint does not return a new refresh_token -- keep reusing the existing one.
  await session.save();
  return session.figmaAccessToken;
}

/**
 * Figma's two token types need different auth headers: an OAuth access token
 * goes in `Authorization: Bearer`, but a personal access token (figd_...)
 * must go in `X-Figma-Token` -- Figma rejects a PAT sent as Bearer with a
 * 401 ("figd_ tokens must be passed via X-Figma-Token header"). The local
 * FIGMA_ACCESS_TOKEN fallback above is a PAT, so we route by prefix.
 */
function figmaAuthHeaders(token: string): Record<string, string> {
  return token.startsWith("figd_") ? { "X-Figma-Token": token } : { Authorization: `Bearer ${token}` };
}

/** GET against the Figma REST API with the given token (OAuth or PAT). */
export async function figmaGet<T>(path: string, accessToken: string, timeoutMs = FIGMA_FETCH_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FIGMA_API_BASE}${path}`, {
      headers: figmaAuthHeaders(accessToken),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Could not reach ${FIGMA_API_BASE}${path} -- ${describeFigmaError(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Figma API returned ${res.status} for ${path}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * GET /v1/files/:key/nodes -- the full node subtree(s) for the given node
 * ids. `geometry=paths` includes vector path data so icon/vector nodes are
 * resolvable. Used by the design-system codegen to feed a component's REAL
 * Figma design (sizes, fills, radii, layout, typography, structure) into
 * generation instead of just its variant labels -- see
 * src/lib/design-system-codegen/figma-node.ts.
 */
export async function getFileNodes<T>(fileKey: string, nodeIds: string[], accessToken: string): Promise<T> {
  const ids = encodeURIComponent(nodeIds.join(","));
  return figmaGet<T>(`/files/${fileKey}/nodes?ids=${ids}&geometry=paths`, accessToken, FIGMA_FILE_FETCH_TIMEOUT_MS);
}

/**
 * GET /v1/files/:key/nodes but DEPTH-LIMITED and WITHOUT `geometry=paths` -- for
 * callers that only need shallow node properties (fills, strokes, corner radii,
 * text styles) across a subtree, not vector path data. Critical for cost: the
 * full-subtree + geometry variant above is ~52MB for this file (see sync.ts's
 * fetchNodesBatched depth=1 note) and blows the request timeout; a bounded depth
 * with no geometry keeps token harvesting (deriveTokensFromComponents) cheap
 * enough to run inside the sync's budget. `timeoutMs` defaults shorter than the
 * full-file allowance so one slow node fetch can't stall the whole sync.
 */
export async function getFileNodesShallow<T>(
  fileKey: string,
  nodeIds: string[],
  accessToken: string,
  depth: number,
  timeoutMs = 15_000,
): Promise<T> {
  const ids = encodeURIComponent(nodeIds.join(","));
  return figmaGet<T>(`/files/${fileKey}/nodes?ids=${ids}&depth=${depth}`, accessToken, timeoutMs);
}

interface FigmaImagesResponse {
  images: Record<string, string | null>;
  err?: string | null;
}

/**
 * GET /v1/images/:key -- renders the given nodes and returns a map of
 * nodeId -> a short-lived download URL (or null if that node couldn't render).
 * Used to capture a screenshot of an app SCREEN imported from Figma as a
 * reference mockup. `scale` 2 gives a crisp preview; `format` defaults to png.
 */
export async function getFileImages(
  fileKey: string,
  nodeIds: string[],
  accessToken: string,
  { format = "png", scale = 2 }: { format?: "png" | "svg" | "jpg"; scale?: number } = {},
): Promise<Record<string, string | null>> {
  const ids = encodeURIComponent(nodeIds.join(","));
  const res = await figmaGet<FigmaImagesResponse>(
    `/images/${fileKey}?ids=${ids}&format=${format}&scale=${scale}`,
    accessToken,
    FIGMA_FILE_FETCH_TIMEOUT_MS,
  );
  if (res.err) throw new Error(`Figma image render failed: ${res.err}`);
  return res.images ?? {};
}
