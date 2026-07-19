import "server-only";
import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

/**
 * User secrets (GitLab PAT, LLM provider token) are stored ONLY here — in an
 * encrypted httpOnly cookie for the duration of the browser session. They
 * never reach the DB (see PLAN.md, section 3).
 *
 * URLs without tokens (GitLab URL, provider base URL) can safely be stored in
 * the DB (tool_settings) — only the token itself is a secret.
 */
export interface SessionData {
  gitlabUrl?: string;
  gitlabToken?: string;
  llmProviderUrl?: string;
  llmProviderToken?: string;
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is not set or shorter than 32 characters. Generate one, for example: `openssl rand -base64 32`, " +
        "and add it as an environment variable (in Vercel and in .env.local for local development).",
    );
  }
  return secret;
}

const sessionOptions: SessionOptions = {
  get password() {
    return getSessionSecret();
  },
  cookieName: "ai-tools-app-session",
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    // Intentionally do NOT set maxAge — the cookie is a session cookie and
    // lives until the browser is closed / explicit logout; tokens are never persisted.
  },
};

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Partially update the secrets in the session (for example, from the settings form). */
export async function updateSessionSecrets(patch: Partial<SessionData>) {
  const session = await getSession();
  Object.assign(session, patch);
  await session.save();
}

/** Clear all secrets (the "forget tokens" button in settings). */
export async function clearSessionSecrets() {
  const session = await getSession();
  session.gitlabUrl = undefined;
  session.gitlabToken = undefined;
  session.llmProviderUrl = undefined;
  session.llmProviderToken = undefined;
  await session.save();
}

/** Whether secrets have already been entered — to show status in the UI without revealing the values. */
export async function getSecretsStatus() {
  const session = await getSession();
  return {
    hasGitlabToken: Boolean(session.gitlabToken),
    hasLlmProviderToken: Boolean(session.llmProviderToken),
    gitlabUrl: session.gitlabUrl ?? "",
    llmProviderUrl: session.llmProviderUrl ?? "",
  };
}
