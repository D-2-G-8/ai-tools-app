/**
 * Общий контракт AI-инструмента (PLAN.md, раздел 5).
 * Каждый новый инструмент — это запись в registry.ts, без изменения ядра платформы.
 */
export interface ToolDefaultPrompt {
  name: string;
  content: string;
}

export interface ToolDefinition {
  key: string;
  name: string;
  description: string;
  /** Порядок стадии в полном цикле ведения фичи (для feature_workflow.currentStage). */
  stageOrder: number;
  /** Выигрывает ли качество результата от контекста проекта (RAG по документам). */
  benefitsFromContext: boolean;
  defaultPrompts: ToolDefaultPrompt[];
  /** Placeholder: реализация появится по мере проработки каждого инструмента отдельно. */
  status: "planned" | "in_development" | "active";
}
