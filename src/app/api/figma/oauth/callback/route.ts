import { redirect } from "next/navigation";
import { getCurrentUser } from "@/db/users";
import { getSession } from "@/lib/session";
import { exchangeFigmaCode, getPublicOrigin } from "@/lib/figma/oauth";

export const dynamic = "force-dynamic";

// The design-system tool's Settings page (which used to show "Connect
// Figma" / connection status) has been removed; redirect to the app's
// general Settings page instead so this doesn't 404. No page currently
// renders Figma connection status or reads the figma=connected/error
// query params below -- see AGENTS.md / task history for context.
const SETTINGS_PATH = "/settings";

interface FigmaMe {
  email?: string;
  handle?: string;
}

/** GET /v1/me -- just for the "Connected as: ..." display in Settings, best-effort. */
async function fetchFigmaHandle(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://api.figma.com/v1/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const me = (await res.json()) as FigmaMe;
    return me.email ?? me.handle;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    redirect("/sign-in");
  }

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const session = await getSession();
  const expectedState = session.figmaOauthState;
  session.figmaOauthState = undefined;
  await session.save();

  if (error) {
    redirect(`${SETTINGS_PATH}?figma=error&figmaMessage=${encodeURIComponent(error)}`);
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    redirect(`${SETTINGS_PATH}?figma=error&figmaMessage=${encodeURIComponent("Invalid or expired authorization request -- please try connecting again.")}`);
  }

  const redirectUri = new URL("/api/figma/oauth/callback", getPublicOrigin(request)).toString();

  try {
    const token = await exchangeFigmaCode(code, redirectUri);
    const handle = await fetchFigmaHandle(token.access_token);

    session.figmaAccessToken = token.access_token;
    session.figmaRefreshToken = token.refresh_token;
    session.figmaTokenExpiresAt = Date.now() + token.expires_in * 1000;
    session.figmaUserHandle = handle;
    await session.save();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    redirect(`${SETTINGS_PATH}?figma=error&figmaMessage=${encodeURIComponent(message)}`);
  }

  redirect(`${SETTINGS_PATH}?figma=connected`);
}
