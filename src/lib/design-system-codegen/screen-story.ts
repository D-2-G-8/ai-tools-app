import "server-only";
import { generateText } from "ai";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import { pascalCase } from "./component";
import type { DesignComponentVariant, DesignComponentState } from "@/db/schema";

/**
 * Rebuilds an existing app SCREEN (imported from Figma as a reference mockup)
 * as a Storybook story composed from the REAL design-system components. Grounds
 * the model on the screen's screenshot (vision) + its distilled structure, and
 * constrains it to the catalog of design-system components that actually exist
 * (committed), so the output renders in the design-system's Storybook.
 */

export interface CatalogComponent {
  slug: string;
  name: string;
  isIcon: boolean;
  variants: DesignComponentVariant[];
  states: DesignComponentState[];
}

export interface ScreenSourcePaths {
  dir: string;
  storyName: string;
  storyPath: string;
}

/** Where a rebuilt screen's story lives in the design-system repo. */
export function screenSourcePaths(slug: string): ScreenSourcePaths {
  const storyName = pascalCase(slug);
  const dir = `src/screens/${slug}`;
  return { dir, storyName, storyPath: `${dir}/${storyName}.stories.tsx` };
}

/**
 * The design-system components the model may compose from, as import lines with
 * their variant/state options -- so the story uses real components with sane
 * props. Icons import from ../../icons, components from ../../components.
 */
export function buildComponentCatalog(components: CatalogComponent[]): string {
  return components
    .map((c) => {
      const cn = pascalCase(c.slug);
      const dir = c.isIcon ? "icons" : "components";
      const variants = c.variants.map((v) => v.name).join(", ");
      const states = c.states.map((s) => s.name).join(", ");
      const meta = [variants && `variants: ${variants}`, states && `states: ${states}`].filter(Boolean).join("; ");
      return `- import { ${cn} } from "../../${dir}/${c.slug}";${meta ? `  (${meta})` : ""}`;
    })
    .join("\n");
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : trimmed).trim() + "\n";
}

export interface GeneratedScreenStory {
  storyName: string;
  storyPath: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function generateScreenStory(
  model: string,
  args: {
    slug: string;
    screenName: string;
    screenshot: { bytes: Uint8Array; mediaType: string };
    structureText: string | null;
    catalog: string;
  },
): Promise<GeneratedScreenStory> {
  const { storyName, storyPath } = screenSourcePaths(args.slug);
  const anthropic = await getAnthropicClient();

  const result = await generateText({
    model: anthropic(model),
    system:
      "You rebuild an existing product screen as a Storybook CSF3 story (@storybook/react, TypeScript) composed " +
      "ONLY from the given design-system React components. The screenshot shows the CURRENT screen (built with " +
      "old/local components); recreate the SAME layout and content, but assembled from the design-system " +
      "components. Output ONLY the raw .stories.tsx file contents -- no markdown fences, no explanation.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Screen: ${args.screenName}`,
              "",
              "Design-system components you may compose from (use these EXACT import paths; don't import anything else, don't re-implement them):",
              args.catalog || "(none generated yet)",
              "",
              args.structureText
                ? "Distilled structure of the screen (indentation = nesting; WxH px, fills are CSS colors, font:{...} typography):\n" +
                  args.structureText
                : "",
              "",
              "Requirements:",
              `- Default export a Meta with title "Screens/${storyName}", and export one story \`Default\` whose \`render\` returns the assembled screen.`,
              "- Compose the screen out of the design-system components above (plus plain layout divs/CSS for structure). Match the screenshot's layout, spacing, and content.",
              "- Import components ONLY via the exact paths listed. No external packages, no inline re-implementations of a component that exists in the catalog.",
              "- TypeScript must be valid. No default export other than the Meta.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          { type: "image", image: args.screenshot.bytes, mediaType: args.screenshot.mediaType },
        ],
      },
    ],
  });

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  return {
    storyName,
    storyPath,
    content: stripCodeFence(result.text),
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}
