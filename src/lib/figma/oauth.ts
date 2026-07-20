import "server-only";

/**
 * Figma OAuth2 (authorization-code flow). Endpoints/params/scopes verified
 * directly against developers.figma.com/docs/rest-api/oauth-apps/ and
 * .../authentication/ -- see the comments below for the specifics that are
 * easy to get wrong (Basic-auth token exchange, 90-day access tokens, the
 * refresh endpoint not rotating the refresh token).
 *
 * The OAuth app (FIGMA_CLIENT_ID/FIGMA_CLIENT_SECRET) is one app for the
 * whole deployment -- registered once by whoever manages this workspace,
 * see README's Figma setup section. What's per-user is the resulting
 * access/refresh token pair, stored only in that user's session (see
 * src/lib/session.ts) -- each person authorizes with whichever Figma
 * account (personal, work seat, whatever) is convenient for them.
 */

const FIGMA_AUTHORIZE_URL = "https://www.figma.com/oauth";
const FIGMA_TOKEN_URL = "https://api.figma.com/v1/oauth/token";
const FIGMA_REFRESH_URL = "https://api.figma.com/v1/oauth/refresh";

// current_user:read -- for the "Connected as: ..." display in Settings.
// file_content:read -- read a file's document tree + styles (design tokens
// and components sync, see src/lib/figma/sync.ts). Deliberately NOT
// requesting file_variables:read/write: that scope is Enterprise-plan-only,
// and requesting a scope the workspace's Figma plan doesn't support would
// break the connect flow for anyone not on Enterprise.
export const FIGMA_OAUTH_SCOPES = "current_user:read,file_content:read";

interface FigmaClientCredentials {
  clientId: string;
  clientSecret: string;
}

function getClientCredentials(): FigmaClientCredentials {
  const clientId = process.env.FIGMA_CLIENT_ID;
  const clientSecret = process.env.FIGMA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "FIGMA_CLIENT_ID / FIGMA_CLIENT_SECRET are not set -- see README's Figma setup section for how to " +
        "register an OAuth app and where to put these.",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Next.js does NOT rewrite request.url based on X-Forwarded-Proto/-Host when
 * self-hosted behind a reverse proxy (a well-known, still-open gap -- see
 * vercel/next.js#63402, #34553) -- request.url reflects the raw connection
 * the Node process received (typically http://<container>:3000/... behind
 * an HTTPS-terminating proxy), not the public origin. Auth.js's own
 * trustHost: true (see src/auth.ts) solves this for Auth.js's internal
 * routing only, not for plain Route Handlers like the two Figma OAuth
 * routes -- so this does the same header-trusting manually. On Vercel
 * these headers are already correct (or absent, falling back to
 * request.url), so this is a no-op difference there.
 */
export function getPublicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

export function buildFigmaAuthorizeUrl(state: string, redirectUri: string): string {
  const { clientId } = getClientCredentials();
  const url = new URL(FIGMA_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", FIGMA_OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export interface FigmaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  user_id_string?: string;
}

function basicAuthHeader({ clientId, clientSecret }: FigmaClientCredentials): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function postForm(url: string, body: Record<string, string>): Promise<FigmaTokenResponse> {
  const credentials = getClientCredentials();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basicAuthHeader(credentials),
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach ${url} -- ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Figma OAuth request to ${url} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<FigmaTokenResponse>;
}

/**
 * Trades a callback `code` for an access/refresh token pair. The code is
 * single-use and expires in 30 seconds, so this must be called immediately
 * from the callback route handler, not deferred.
 */
export async function exchangeFigmaCode(code: string, redirectUri: string): Promise<FigmaTokenResponse> {
  return postForm(FIGMA_TOKEN_URL, {
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });
}

/**
 * Refreshes an expired/expiring access token. Figma's refresh endpoint does
 * NOT return a new refresh_token -- keep reusing the original one (per
 * Figma's docs it "can be reused as many times as necessary", not a
 * rotating single-use token).
 */
export async function refreshFigmaToken(refreshToken: string): Promise<FigmaTokenResponse> {
  return postForm(FIGMA_REFRESH_URL, { refresh_token: refreshToken });
}
