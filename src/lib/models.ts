/**
 * Каталог моделей и цен для вкладки "Статистика" (оценка стоимости запроса).
 * Цены — $ за 1M токенов, состояние на июль 2026 (см. PLAN.md, раздел 11).
 * ВАЖНО: цены провайдеров меняются — периодически сверяй с
 * https://platform.claude.com/docs/en/about-claude/pricing и обновляй здесь.
 */
export interface ModelInfo {
  id: string;
  label: string;
  provider: "anthropic";
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  isDefault?: boolean;
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet (по умолчанию)",
    provider: "anthropic",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    isDefault: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku (быстрее и дешевле)",
    provider: "anthropic",
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus (максимальное качество)",
    provider: "anthropic",
    inputPricePerMTok: 5,
    outputPricePerMTok: 25,
  },
];

export const DEFAULT_MODEL_ID = AVAILABLE_MODELS.find((m) => m.isDefault)!.id;

export function getModelInfo(modelId: string): ModelInfo {
  return AVAILABLE_MODELS.find((m) => m.id === modelId) ?? AVAILABLE_MODELS[0];
}

export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = getModelInfo(modelId);
  return (
    (inputTokens / 1_000_000) * model.inputPricePerMTok +
    (outputTokens / 1_000_000) * model.outputPricePerMTok
  );
}
