import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { getAnthropicClient } from "@/lib/llm/client";
import type { Finding, FileKind } from "./review";

const visualFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        area: z.string().describe('what part, e.g. "border", "label", "icon spacing"'),
        severity: z.enum(["major", "minor"]),
        description: z.string().describe("the concrete visual discrepancy of the RENDERED vs the DESIGN"),
        suggestion: z.string().optional().describe("concrete CSS/TSX change, e.g. \"border-radius: 8px not 16px\""),
      }),
    )
    .describe("Visual discrepancies the rendered component has vs the Figma design; empty if it matches."),
});

/** Vision-diff: grade the RENDERED component screenshot against the Figma DESIGN
 *  and return concrete visual discrepancies. Best-effort ([] on failure -- a
 *  vision outage must never block). All findings are severity "quality" (visual,
 *  non-build-breaking). */
export async function reviewVisualDiff(
  model: string,
  figma: { bytes: Uint8Array; mediaType: string },
  rendered: { bytes: Uint8Array; mediaType: string },
  componentName: string,
  spec?: string,
): Promise<{ findings: Finding[]; inputTokens: number; outputTokens: number }> {
  try {
    const anthropic = await getAnthropicClient();
    const result = await generateObject({
      model: anthropic(model),
      schema: visualFindingsSchema,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Component: ${componentName}. Image A is the Figma DESIGN (the target). Image B is the ` +
                `CURRENT rendered component (a Storybook screenshot). List concrete VISUAL discrepancies B has ` +
                `vs A: wrong size/border-radius/padding/gap/color/font-weight, missing or extra elements, ` +
                `misalignment. Be specific and actionable. IGNORE differences that are just the Figma variant ` +
                `matrix vs a single instance, and ignore the surrounding canvas/background chrome. If B matches ` +
                `A, return an empty list.` + (spec ? `\nMeasured design spec for reference:\n${spec}` : ""),
            },
            { type: "image", image: figma.bytes, mediaType: figma.mediaType },
            { type: "image", image: rendered.bytes, mediaType: rendered.mediaType },
          ],
        },
      ],
    });
    return {
      findings: result.object.findings.map((f) => ({
        id: `visual-${f.area.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "diff"}`,
        severity: "quality" as const,
        file: "css" as FileKind,
        message: `[visual/${f.severity}] ${f.area}: ${f.description}`,
        suggestion: f.suggestion,
      })),
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    };
  } catch {
    return { findings: [], inputTokens: 0, outputTokens: 0 };
  }
}
