/**
 * Catalog of models and prices for the "Statistics" tab (request cost estimation).
 * Prices are in $ per 1M tokens, as of July 2026 (see PLAN.md, section 11).
 * IMPORTANT: provider prices change — periodically cross-check against
 * https://platform.claude.com/docs/en/about-claude/pricing and update here.
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
    label: "Claude Sonnet (default)",
    provider: "anthropic",
    inputPricePerMTok: 2,
    outputPricePerMTok: 10,
    isDefault: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku (faster and cheaper)",
    provider: "anthropic",
    inputPricePerMTok: 1,
    outputPricePerMTok: 5,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus (maximum quality)",
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
