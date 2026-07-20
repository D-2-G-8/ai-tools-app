import type { ToolDefinition } from "./types";
import { BUSINESS_REQUIREMENTS_SYSTEM_PROMPT } from "./business-requirements-template";

/**
 * Registry of the platform's AI tools (PLAN.md, sections 1 and 8).
 * The default prompts are draft starting points; the user can edit or extend
 * them on the "Prompts" tab of each tool (prompt_template).
 */
export const TOOLS: ToolDefinition[] = [
  {
    key: "business-requirements",
    name: "Business Requirements",
    description: "Interviews you in chat and drafts a full Business Requirements document from a fixed template.",
    stageOrder: 1,
    benefitsFromContext: true,
    status: "active",
    chatMode: true,
    defaultPrompts: [
      {
        name: "Business Requirements interview",
        content: BUSINESS_REQUIREMENTS_SYSTEM_PROMPT,
      },
    ],
  },
  {
    key: "system-analysis",
    name: "System Analysis / Design",
    description: "Helps design the solution and write the system analysis for a feature.",
    stageOrder: 2,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [
      {
        name: "System analysis draft",
        content:
          "You are acting as a systems analyst. Based on the business requirements and the project context " +
          "(existing architecture, documentation), propose a technical solution: " +
          "affected components, changes to contracts/APIs, risks, and open questions.\n\n" +
          "Business requirements: {{business_requirements}}\n\nProject context: {{project_context}}",
      },
    ],
  },
  {
    key: "design",
    name: "Design",
    description: "Speeds up preparing the design for a feature.",
    stageOrder: 3,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
  {
    key: "autocoding",
    name: "Code Generation",
    description: "Writes code from the system analysis without a developer's involvement at this step.",
    stageOrder: 4,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
  {
    key: "code-review",
    name: "Code Review",
    description: "AI Review of open GitLab merge requests -- V1 (single model), V2 (two models + a judge), or V3 (multi-agent, business-context-aware).",
    stageOrder: 5,
    benefitsFromContext: true,
    status: "active",
    // Custom UI (see code-review-panel.tsx, special-cased into
    // tools/[toolKey]/page.tsx) -- pulls diffs live from GitLab rather than
    // running through the generic prompt+input runner, so defaultPrompts
    // here isn't used to drive a run; kept only as the seed prompt shown if
    // someone opens the Prompts tab for this tool.
    defaultPrompts: [
      {
        name: "Basic code review",
        content:
          "Perform a code review of the diff below. Check correctness, security, performance, " +
          "edge cases, and conformance to the described system analysis (if it is present in the context). " +
          "Provide a list of findings with the file/line and severity.\n\nDiff: {{diff}}\n\nProject context: {{project_context}}",
      },
    ],
  },
  {
    key: "testing",
    name: "Automated Tests",
    description: "Improves quality and automated test coverage.",
    stageOrder: 6,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [],
  },
];

export function getTool(key: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.key === key);
}

/**
 * Friendly display name for a `run.toolKey`, including toolKeys that have
 * no entry in TOOLS above (no dedicated tool page of their own) but still
 * get run rows -- e.g. "design-system-codegen" (src/app/api/design-system/
 * codegen/[slug]/route.ts). Shared by every place that lists runs by
 * toolKey (Company page's usage-by-tool table, History's "Tool runs"
 * table) so a toolKey not in the registry doesn't show up as a raw,
 * unfriendly string in one place while reading fine in another.
 */
export function toolDisplayName(toolKey: string): string {
  if (toolKey === "documents-qa") return "Documents Q&A";
  if (toolKey === "document-format") return "Document formatting";
  if (toolKey === "design-system-codegen") return "Design system code sync";
  return getTool(toolKey)?.name ?? toolKey;
}
