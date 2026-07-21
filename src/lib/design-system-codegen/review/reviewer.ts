import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { getAnthropicClient } from "@/lib/llm/client";
import type { Finding, GeneratedFiles, FileKind } from "./types";

const findingsSchema = z.object({
  findings: z
    .array(
      z.object({
        id: z.string().describe("short kebab-case rule slug, e.g. \"inert-prop\" or \"compounded-transform\""),
        file: z.enum(["tsx", "css", "stories", "index"]),
        message: z.string().describe("what's wrong, concretely, referencing the design spec"),
        suggestion: z.string().optional().describe("concrete fix"),
      }),
    )
    .describe("DoD/AC violations found; empty array if the component fully satisfies the checklist"),
});

// The B (fidelity) + C (behavior/API) DoD sections, verbatim, as the review
// rubric. Deterministic build-safety (A) is handled separately.
const DOD_RUBRIC = [
  "Design fidelity vs the Figma spec:",
  "- DOM structure/nesting matches the spec.",
  "- Sizes/radii/gaps/padding match the measured values.",
  "- Colors/typography/shadows use var(--token) matching the design, not hardcoded, where a matching token exists.",
  "- Composes the real design-system component instances marked `USE <Name>` in the spec (icons/subcomponents) instead of re-implementing them, and renders the correct instance per state.",
  "- Background/border/fill belong to the component itself, not a showcase frame.",
  "Behavior/API:",
  "- Every prop that comes from a variant/state visibly changes the render (no inert props).",
  "- Interactive toggles use the controlled/uncontrolled hybrid (value?/default…?/on…Change?) and work standalone (click toggles).",
  "- Each state-driven change is applied via exactly one mechanism (no compounded transforms; icon-swap XOR CSS rotate).",
  "- Every prop has a JSDoc description; the stories file sets argTypes with descriptions.",
  "- The Default story renders and demonstrates interaction; story args use only valid literal values from the prop types.",
].join("\n");

/** One LLM pass grading the generated files against the fidelity/behavior DoD.
 *  Best-effort: returns [] on any failure (never blocks a commit on a review
 *  outage). Deterministic build-safety gates run separately. */
export async function reviewWithLlm(
  model: string,
  files: GeneratedFiles,
  spec: string | undefined,
  componentName: string,
  composedApi?: string,
): Promise<{ findings: Finding[]; inputTokens: number; outputTokens: number }> {
  try {
    const anthropic = await getAnthropicClient();
    const result = await generateObject({
      model: anthropic(model),
      schema: findingsSchema,
      system:
        "You are a senior design-system reviewer. Grade the generated component STRICTLY against the checklist. " +
        "Report ONLY real violations with concrete, actionable messages. Do not restyle or nitpick beyond the checklist.",
      prompt: [
        `Component: ${componentName}`,
        spec ? `Figma design spec (the reference):\n${spec}` : "No Figma spec available -- grade behavior/API only.",
        // Composed children's REAL contract values (when this component composes
        // others). Without this the reviewer reads the spec's raw Figma variant
        // LABELS (Appearance=Negative, Size=24 px) as the target and wrongly
        // flags the correct mapped code (appearance="negative", size="24px") as
        // infidelity -- fighting the deterministic composition-value gate so the
        // autofix can't converge. This section + the checklist clause below stop
        // that.
        composedApi
          ? `\n${composedApi}\nWhen grading composed-child instance props, the CORRECT value is the child's real ` +
            "contract value above (lowercase, units per the child's type), NOT the raw Figma label. Do NOT flag " +
            'a mapped value (e.g. appearance="negative" for Figma Appearance=Negative, size="24px" for Size=24 px) ' +
            "as a fidelity violation -- that mapping is required and correct."
          : "",
        "",
        "Checklist:",
        DOD_RUBRIC,
        "",
        "Generated files:",
        `--- ${componentName}.tsx ---\n${files.tsx}`,
        `--- ${componentName}.module.scss ---\n${files.css}`,
        `--- ${componentName}.stories.tsx ---\n${files.stories}`,
      ].join("\n"),
    });
    return {
      findings: result.object.findings.map((f) => ({
        id: f.id,
        severity: "quality" as const,
        file: f.file as FileKind,
        message: f.message,
        suggestion: f.suggestion,
      })),
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    };
  } catch {
    return { findings: [], inputTokens: 0, outputTokens: 0 };
  }
}
