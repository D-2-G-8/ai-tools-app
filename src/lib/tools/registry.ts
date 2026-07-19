import type { ToolDefinition } from "./types";

/**
 * Registry of the platform's AI tools (PLAN.md, sections 1 and 8).
 * The default prompts are draft starting points; the user can edit or extend
 * them on the "Prompts" tab of each tool (prompt_template).
 */
export const TOOLS: ToolDefinition[] = [
  {
    key: "business-requirements",
    name: "Business Requirements",
    description: "Speeds up drafting business requirements for a feature based on project context.",
    stageOrder: 1,
    benefitsFromContext: true,
    status: "planned",
    defaultPrompts: [
      {
        name: "Business requirements draft",
        content:
          "You are helping an analyst prepare business requirements for a new feature.\n" +
          "Based on the feature description and the project context (uploaded documentation), formulate:\n" +
          "1) the problem and goal, 2) the target audience, 3) key business scenarios, " +
          "4) success criteria, 5) out of scope.\n\nFeature description: {{feature_description}}\n\nProject context: {{project_context}}",
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
    description: "Performs a code review of the changes. A working implementation already exists — integration is pending.",
    stageOrder: 5,
    benefitsFromContext: true,
    status: "planned",
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
