import { createAnthropic } from "@ai-sdk/anthropic";
import { getSession } from "@/lib/session";

/**
 * Builds an Anthropic-compatible client for the Vercel AI SDK, using the
 * user's session-scoped token (not stored in the DB) if one has been entered,
 * otherwise ANTHROPIC_API_KEY from the server environment (convenient for local
 * development / personal use, so you don't have to enter the token every time).
 *
 * A custom providerBaseUrl is supported likewise — for cases where the user
 * wants to route through their own proxy/gateway.
 */
export async function getAnthropicClient() {
  const session = await getSession();

  const apiKey = session.llmProviderToken || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No LLM provider token is set. Enter it in Settings (stored only for the duration of the session) " +
        "or set ANTHROPIC_API_KEY in the server's environment variables.",
    );
  }

  const baseURL = session.llmProviderUrl || undefined;

  return createAnthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}
