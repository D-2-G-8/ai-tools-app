import { EMBEDDING_DIMENSIONS } from "@/db/schema";

/**
 * У Claude нет собственного embeddings API — Anthropic рекомендует Voyage AI
 * (см. PLAN.md, раздел 11). Используем voyage-3-lite (512 измерений, дёшево:
 * $0.06 / 1M токенов) — для .md документов этого достаточно с запасом.
 *
 * Ключ VOYAGE_API_KEY — серверная переменная окружения платформы (это не
 * личный токен пользователя из настроек, а ключ самого приложения для
 * инфраструктурной функции инжеста).
 */
const VOYAGE_MODEL = "voyage-3-lite";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY не задан. Это отдельный ключ платформы для эмбеддингов (не токен пользователя) — " +
        "получить на https://www.voyageai.com и добавить в переменные окружения.",
    );
  }

  // Voyage принимает до 128 текстов за раз — батчим на всякий случай.
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
      throw new Error(`Voyage embeddings API вернул ошибку ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    result.push(...sorted.map((d) => d.embedding));
  }

  return result;
}
