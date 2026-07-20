import "server-only";
import { getSession } from "@/lib/session";
import { refreshFigmaToken } from "./oauth";

const FIGMA_API_BASE = "https://api.figma.com/v1";
const FIGMA_FETCH_TIMEOUT_MS = 20_000;
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
  if (!session.figmaAccessToken) return null;

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

/** GET against the Figma REST API with the given bearer token. */
export async function figmaGet<T>(path: string, accessToken: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${FIGMA_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FIGMA_FETCH_TIMEOUT_MS),
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
