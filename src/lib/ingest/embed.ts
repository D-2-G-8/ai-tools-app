import { EMBEDDING_DIMENSIONS } from "@/db/schema";

/**
 * Claude has no embeddings API of its own — Anthropic recommends Voyage AI
 * (see PLAN.md, section 11). We use voyage-3-lite (512 dimensions, cheap:
 * $0.06 / 1M tokens) — more than enough for .md documents.
 *
 * The VOYAGE_API_KEY is a server-side environment variable of the platform (it
 * is not the user's personal token from settings, but the application's own key
 * for the infrastructural ingest function).
 */
const VOYAGE_MODEL = "voyage-3-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. This is a separate platform key for embeddings (not a user token) — " +
        "get one at https://www.voyageai.com and add it to the environment variables.",
    );
  }

  // Voyage accepts up to 128 texts at a time — batch just in case.
  const BATCH = 128;
  const result: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: batch,
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Voyage embeddings API returned error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    result.push(...sorted.map((d) => d.embedding));
  }

  return result;
}
