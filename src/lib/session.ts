import "server-only";
import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

/**
 * Секреты пользователя (GitLab PAT, токен LLM-провайдера) хранятся ТОЛЬКО
 * здесь — в зашифрованной httpOnly cookie на время браузерной сессии.
 * Они никогда не попадают в БД (см. PLAN.md, раздел 3).
 *
 * URL-ы без токенов (GitLab URL, provider base URL) можно спокойно хранить
 * в БД (tool_settings) — секретом является только сам токен.
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
      "SESSION_SECRET не задан или короче 32 символов. Сгенерируй, например: `openssl rand -base64 32`, " +
        "и добавь как переменную окружения (в Vercel и в .env.local для локальной разработки).",
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
    // Намеренно НЕ ставим maxAge — cookie сессионная и живёт до закрытия
    // браузера / явного логаута, токены нигде не персистятся.
  },
};

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Частично обновить секреты в сессии (например, из формы настроек). */
export async function updateSessionSecrets(patch: Partial<SessionData>) {
  const session = await getSession();
  Object.assign(session, patch);
  await session.save();
}

/** Очистить все секреты (кнопка "забыть токены" в настройках). */
export async function clearSessionSecrets() {
  const session = await getSession();
  session.gitlabUrl = undefined;
  session.gitlabToken = undefined;
  session.llmProviderUrl = undefined;
  session.llmProviderToken = undefined;
  await session.save();
}

/** Есть ли уже введённые секреты — для отображения статуса в UI без раскрытия значений. */
export async function getSecretsStatus() {
  const session = await getSession();
  return {
    hasGitlabToken: Boolean(session.gitlabToken),
    hasLlmProviderToken: Boolean(session.llmProviderToken),
    gitlabUrl: session.gitlabUrl ?? "",
    llmProviderUrl: session.llmProviderUrl ?? "",
  };
}
