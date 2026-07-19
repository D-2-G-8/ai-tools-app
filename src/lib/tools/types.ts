/**
 * Common contract for an AI tool (PLAN.md, section 5).
 * Each new tool is an entry in registry.ts, with no changes to the platform core.
 */
export interface ToolDefaultPrompt {
  name: string;
  content: string;
}

export interface ToolDefinition {
  key: string;
  name: string;
  description: string;
  /** Stage order in the full feature lifecycle (for feature_workflow.currentStage). */
  stageOrder: number;
  /** Whether the result quality benefits from project context (RAG over documents). */
  benefitsFromContext: boolean;
  defaultPrompts: ToolDefaultPrompt[];
  /** Placeholder: implementation will appear as each tool is developed separately. */
  status: "planned" | "in_development" | "active";
  /**
   * Chat-style tools (currently: Business Requirements) run as a multi-turn
   * interview instead of the single-shot prompt+input runner — see
   * src/app/tools/[toolKey]/chat-actions.ts and chat-runner.tsx.
   */
  chatMode?: boolean;
}
