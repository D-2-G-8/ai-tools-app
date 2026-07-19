import { createAnthropic } from "@ai-sdk/anthropic";
import { getSession } from "@/lib/session";

/**
 * Собирает Anthropic-совместимый клиент для Vercel AI SDK, используя
 * сессионный (не сохранённый в БД) токен пользователя, если он введён,
 * иначе — ANTHROPIC_API_KEY из окружения сервера (удобно для локальной
 * разработки/личного пользования, чтобы не вводить токен каждый раз).
 *
 * Аналогично поддерживается кастомный providerBaseUrl — для случаев,
 * когда пользователь хочет ходить через свой прокси/gateway.
 */
export async function getAnthropicClient() {
  const session = await getSession();

  const apiKey = session.llmProviderToken || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Не задан токен LLM-провайдера. Введи его в Настройках (хранится только на время сессии) " +
        "или задай ANTHROPIC_API_KEY в переменных окружения сервера.",
    );
  }

  const baseURL = session.llmProviderUrl || undefined;

  return createAnthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}
