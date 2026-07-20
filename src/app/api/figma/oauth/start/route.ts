import { redirect } from "next/navigation";
import { getCurrentUser } from "@/db/users";
import { getSession } from "@/lib/session";
import { buildFigmaAuthorizeUrl, getPublicOrigin } from "@/lib/figma/oauth";

export const dynamic = "force-dynamic";

/**
 * Kicks off the "Connect Figma" flow from the design-system Settings page.
 * A plain link (not a Server Action) on purpose -- this needs to issue a
 * real 302 to www.figma.com, which a Server Action can't do cleanly for an
 * external origin.
 *
 * The redirect_uri is derived from the incoming request's own origin
 * (never a hardcoded/env-configured base URL) so this works unchanged on
 * Vercel, any self-hosted domain, and localhost -- same reasoning as
 * src/auth.ts's trustHost: true for Auth.js. Whatever origin this route is
 * reached on must be registered as an allowed redirect URI on the Figma
 * OAuth app (see README) -- Figma allows registering more than one.
 */
export async function GET(request: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    redirect("/sign-in");
  }

  const state = crypto.randomUUID();
  const session = await getSession();
  session.figmaOauthState = state;
  await session.save();

  const redirectUri = new URL("/api/figma/oauth/callback", getPublicOrigin(request)).toString();
  redirect(buildFigmaAuthorizeUrl(state, redirectUri));
}
