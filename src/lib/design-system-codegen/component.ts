import "server-only";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import type { DesignComponentVariant, DesignComponentState } from "@/db/schema";
import type { TokenForCss } from "./tokens";

/**
 * Turns one design_component row (+ the workspace's currently-synced
 * tokens) into real React/CSS/Storybook source files for the design-system
 * repo. Deliberately NOT one generateObject call producing the whole TSX
 * and stylesheet as sibling JSON-string fields -- generateObject/structured
 * output is solid for short, schema-friendly data (this codebase's only
 * existing precedent, src/lib/code-review/*.ts, generates short JSON
 * findings), but two independently-generated large source files inside one
 * schema have nothing forcing them to actually agree with each other (a
 * class name typo'd differently in each field is a likely, hard-to-catch
 * failure mode), and large source files as JSON-string values are more
 * failure-prone (escaping, truncation) than plain text generation.
 *
 * Pipeline instead:
 * 1. contract (generateObject, genuinely schema-friendly: prop names/
 *    types, chosen CSS class names, chosen token references).
 * 2/3/4. TSX / stylesheet / stories, each a plain generateText completion
 *    given the SAME contract as fixed shared input, so all three are
 *    forced to agree on names instead of guessing independently.
 * Then a deterministic (no LLM) check that every class the TSX references
 * actually exists in the generated stylesheet, run BEFORE anything is
 * committed (see src/lib/github/client.ts's caller in the codegen route).
 *
 * A real `tsc --noEmit`-in-package-context gate (as originally scoped) is
 * NOT done here: that needs the design-system repo's own toolchain
 * (React/TypeScript/Vite) available, which isn't practical to install
 * inside a Vercel serverless invocation under a 60s budget. Instead the
 * design-system repo runs its own CI (typecheck/lint/build) on the pull
 * request this generates, and a person reviews that status before clicking
 * "Confirm & merge" -- see that repo's .github/workflows/ci.yml.
 */

export interface ComponentForCodegen {
  slug: string;
  name: string;
  description?: string;
  variants: DesignComponentVariant[];
  states: DesignComponentState[];
}

export interface GeneratedComponentFiles {
  componentName: string;
  /** Paths relative to the design-system repo root. */
  tsxPath: string;
  tsxContent: string;
  cssPath: string;
  cssContent: string;
  storiesPath: string;
  storiesContent: string;
  indexPath: string;
  indexContent: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const contractSchema = z.object({
  props: z
    .array(
      z.object({
        name: z.string().describe("camelCase prop name, e.g. \"size\" or \"disabled\"."),
        type: z.string().describe('TypeScript type as a string, e.g. "\'sm\' | \'md\' | \'lg\'" or "boolean".'),
        description: z.string().optional(),
      }),
    )
    .describe(
      "Props derived from this component's Figma variants/states. Group related variants into one " +
        'enum-typed prop where sensible (e.g. "Size: Small"/"Size: Large" variants become one `size` prop).',
    ),
  cssVariables: z
    .array(z.string())
    .describe(
      "Exact token names (without -- prefix or var()) this component should reference, chosen ONLY from " +
        "the provided list of available tokens -- never invent a token name that wasn't given.",
    ),
  classNames: z
    .array(z.string())
    .describe(
      "CSS Modules class names this component's stylesheet will define and the TSX will reference via " +
        "styles.<name>. MUST be camelCase with no hyphens (e.g. \"buttonPrimary\", not \"button-primary\") " +
        "so the TSX and CSS reference the exact same identifier.",
    ),
});

type ComponentContract = z.infer<typeof contractSchema>;

function pascalCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export interface ComponentSourcePaths {
  dir: string;
  componentName: string;
  tsxPath: string;
  cssPath: string;
  storiesPath: string;
  indexPath: string;
}

/**
 * The exact repo-relative paths a component's generated files live at,
 * derived purely from its slug (same pascalCase(slug) generateComponentCode
 * uses). Single source of truth for both writing those paths (below) and
 * deleting them (design-system/components/actions.ts, settings/cleanup-
 * actions.ts's "remove code-synced component(s)" flow) -- so a rename of
 * this convention can't silently desync the two.
 */
export function componentSourcePaths(slug: string): ComponentSourcePaths {
  const componentName = pascalCase(slug);
  const dir = `src/components/${slug}`;
  return {
    dir,
    componentName,
    tsxPath: `${dir}/${componentName}.tsx`,
    cssPath: `${dir}/${componentName}.module.css`,
    storiesPath: `${dir}/${componentName}.stories.tsx`,
    indexPath: `${dir}/index.ts`,
  };
}

function describeComponent(component: ComponentForCodegen): string {
  const variantLines = component.variants.map((v) => `- ${v.name}${v.description ? ` -- ${v.description}` : ""}`);
  const stateLines = component.states.map((s) => `- ${s.name}${s.description ? ` -- ${s.description}` : ""}`);
  return [
    `Component name: ${component.name}`,
    component.description ? `Description: ${component.description}` : "",
    variantLines.length ? `Variants (from Figma):\n${variantLines.join("\n")}` : "No variants.",
    stateLines.length ? `States (from Figma):\n${stateLines.join("\n")}` : "No states.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Strips a markdown code fence if the model wraps its output in one despite instructions not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : trimmed).trim() + "\n";
}

async function generateContract(
  model: string,
  component: ComponentForCodegen,
  availableTokens: TokenForCss[],
): Promise<{ contract: ComponentContract; inputTokens: number; outputTokens: number }> {
  const anthropic = await getAnthropicClient();
  const result = await generateObject({
    model: anthropic(model),
    schema: contractSchema,
    system:
      "You are designing the API contract for a React component that will be implemented as a CSS Modules " +
      "component in a shared design-system library. Output only the contract -- no implementation code.",
    prompt: [
      describeComponent(component),
      "",
      `Available design tokens (choose only from these -- never invent one): ${availableTokens.map((t) => t.name).join(", ") || "(none synced yet)"}`,
    ].join("\n"),
  });
  return {
    contract: result.object,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

async function generateTsx(
  model: string,
  component: ComponentForCodegen,
  contract: ComponentContract,
  componentName: string,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const anthropic = await getAnthropicClient();
  const result = await generateText({
    model: anthropic(model),
    system:
      "You write production React + TypeScript components for a shared component library. Output ONLY the " +
      "raw .tsx file contents -- no markdown code fences, no explanation before or after.",
    prompt: [
      describeComponent(component),
      "",
      `Component name: ${componentName}`,
      `Props:\n${contract.props.map((p) => `- ${p.name}: ${p.type}${p.description ? ` -- ${p.description}` : ""}`).join("\n")}`,
      `CSS Modules class names available (import from "./${componentName}.module.css" as \`styles\`, reference ONLY via styles.<name>, exactly these names): ${contract.classNames.join(", ")}`,
      "",
      "Requirements:",
      `- Named export \`${componentName}\`, plus an exported \`${componentName}Props\` interface.`,
      "- Extend the appropriate native HTML element attributes type where sensible (e.g. ButtonHTMLAttributes for a button).",
      "- Reference styles ONLY via styles.<name> using the exact class names listed above -- never invent a class name, never use inline styles, never hardcode a color/size value.",
      "- No default export.",
    ].join("\n"),
  });
  return {
    content: stripCodeFence(result.text),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

async function generateCss(
  model: string,
  component: ComponentForCodegen,
  contract: ComponentContract,
  availableTokens: TokenForCss[],
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const tokenByName = new Map(availableTokens.map((t) => [t.name, t]));
  const chosenTokens = contract.cssVariables
    .map((name) => tokenByName.get(name))
    .filter((t): t is TokenForCss => Boolean(t));

  const anthropic = await getAnthropicClient();
  const result = await generateText({
    model: anthropic(model),
    system:
      "You write CSS Modules stylesheets for a shared component library. Output ONLY the raw .module.css " +
      "file contents -- no markdown code fences, no explanation before or after.",
    prompt: [
      describeComponent(component),
      "",
      `Define EXACTLY these top-level class selectors, no more, no fewer, all camelCase (e.g. .buttonPrimary): ${contract.classNames.join(", ")}`,
      `Reference values ONLY via var(--token-name) using these tokens (never a hardcoded color/size/shadow value, never a token not in this list):`,
      chosenTokens.map((t) => `- --${t.name} (${t.category}): ${t.value}`).join("\n") || "(no tokens chosen)",
    ].join("\n"),
  });
  return {
    content: stripCodeFence(result.text),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

async function generateStories(
  model: string,
  component: ComponentForCodegen,
  contract: ComponentContract,
  componentName: string,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const anthropic = await getAnthropicClient();
  const result = await generateText({
    model: anthropic(model),
    system:
      "You write Storybook CSF3 stories (@storybook/react, TypeScript) for a shared component library. " +
      "Output ONLY the raw .stories.tsx file contents -- no markdown code fences, no explanation.",
    prompt: [
      describeComponent(component),
      "",
      `Component: ${componentName}, imported from "./${componentName}" (a barrel that re-exports it).`,
      `Props:\n${contract.props.map((p) => `- ${p.name}: ${p.type}`).join("\n")}`,
      "",
      "Follow this exact structure (adjust component/args/stories to this component, but keep `title` and " +
        "the `Default` story EXACTLY as shown -- the platform deep-links to this specific story id):",
      "```",
      'import type { Meta, StoryObj } from "@storybook/react";',
      'import { Button } from "./Button";',
      "",
      "const meta: Meta<typeof Button> = {",
      `  title: "Components/${componentName}",`,
      "  component: Button,",
      '  args: { children: "Button" },',
      "};",
      "export default meta;",
      "",
      "type Story = StoryObj<typeof Button>;",
      "",
      "export const Default: Story = {};",
      'export const Primary: Story = { args: { variant: "primary" } };',
      "```",
      `REQUIRED: title must be exactly "Components/${componentName}", and there must be exactly one story ` +
        'exported as `Default` (using the component\'s default args, like the example above) -- this is the ' +
        "canonical story the component detail page embeds. Beyond that, add one story per meaningfully " +
        "distinct variant/state combination -- don't enumerate every possible cross-product if that would " +
        "be excessive, use judgment for what's useful to preview.",
    ].join("\n"),
  });
  return {
    content: stripCodeFence(result.text),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

export interface ClassNameCheckResult {
  ok: boolean;
  missingClasses: string[];
}

/**
 * Every class name CSS Modules would expose as an export key from this
 * stylesheet -- i.e. every `.identifier` token appearing ANYWHERE in a
 * selector, not just ones written as their own standalone top-level rule.
 * Real CSS Modules tooling (css-loader, Vite, PostCSS) extracts a class
 * from any selector position: compound (`.toggle.checked`), combinator
 * (`.list .item`), comma-separated (`.a, .b`), pseudo-class (`.btn:hover`),
 * inside @media, etc.
 *
 * A previous version of this function only matched a class if it was the
 * FIRST token of a standalone top-level selector (`^\s*\.name\s*[,{:]`),
 * which produced false "missing class" failures for the very common,
 * idiomatic pattern of a boolean/state modifier written as a compound
 * selector -- e.g. `.toggle.checked { ... }` for a `checked` prop. This is
 * confirmed to have blocked real generations in production: Toggle
 * (checked/unchecked/size16/24/32), Checkbox (size16/24/multi/b2b),
 * InputText (10+ state modifiers: filled/blur/error/focus/readOnly/
 * disabled/etc.), Accordion (opened/themeLight/themeDark), AvatarGroup
 * (themeLight/themeDark), BadgeCount (square) -- every one of these is a
 * modifier class the model correctly defined as a compound selector, which
 * the old anchored regex simply never looked past the first class of.
 *
 * This scans only the selector portion of each rule (text between the
 * previous `}`/start and the next `{`), so declaration values are never
 * mistaken for classes -- and couldn't be even without that: a class match
 * requires a letter/underscore/hyphen immediately after the dot, which
 * already excludes decimals like the `.5` in `scale(1.5)` or `48.5em`.
 */
function extractDefinedClassNames(cssContent: string): Set<string> {
  const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
  const defined = new Set<string>();
  for (const m of withoutComments.matchAll(/([^{}]*)\{/g)) {
    for (const cm of m[1].matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)) defined.add(cm[1]);
  }
  return defined;
}

/**
 * Deterministic (no LLM) safety check: every `styles.<name>` the TSX
 * references must have a matching class defined somewhere in the generated
 * stylesheet (see extractDefinedClassNames). Catches the exact failure
 * mode two independently generated files are prone to (a class name that
 * doesn't match) before anything is committed -- see this module's top
 * comment.
 */
export function checkClassNamesMatch(tsxContent: string, cssContent: string): ClassNameCheckResult {
  const referenced = new Set<string>();
  for (const m of tsxContent.matchAll(/styles\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) referenced.add(m[1]);
  for (const m of tsxContent.matchAll(/styles\[["']([^"']+)["']\]/g)) referenced.add(m[1]);

  const defined = extractDefinedClassNames(cssContent);

  const missingClasses = [...referenced].filter((name) => !defined.has(name));
  return { ok: missingClasses.length === 0, missingClasses };
}

/**
 * Generates one component's full file set. Throws (does not commit
 * anything itself -- that's the caller's job, see the codegen route) if
 * the deterministic class-name check fails, since committing mismatched
 * TSX/CSS would ship a component that renders unstyled.
 */
export async function generateComponentCode(
  model: string,
  component: ComponentForCodegen,
  availableTokens: TokenForCss[],
): Promise<GeneratedComponentFiles> {
  // Computed from the slug rather than asked of the LLM (the contract
  // schema used to have a `componentName` field) -- this makes the
  // Storybook story id ("components-<sanitized componentName>--default")
  // fully derivable from component.slug alone, which is what the
  // component detail page's Storybook iframe link needs (see
  // src/app/(protected)/design-system/components/[slug]/page.tsx).
  const paths = componentSourcePaths(component.slug);
  const componentName = paths.componentName;
  const { contract, inputTokens: t1, outputTokens: o1 } = await generateContract(model, component, availableTokens);

  const [tsx, css, stories] = await Promise.all([
    generateTsx(model, component, contract, componentName),
    generateCss(model, component, contract, availableTokens),
    generateStories(model, component, contract, componentName),
  ]);

  const check = checkClassNamesMatch(tsx.content, css.content);
  if (!check.ok) {
    throw new Error(
      `Generated ${componentName}: TSX references CSS Modules classes not defined in the stylesheet -- ` +
        `${check.missingClasses.join(", ")}. Not committing a mismatched component.`,
    );
  }

  const inputTokens = t1 + tsx.inputTokens + css.inputTokens + stories.inputTokens;
  const outputTokens = o1 + tsx.outputTokens + css.outputTokens + stories.outputTokens;

  return {
    componentName,
    tsxPath: paths.tsxPath,
    tsxContent: tsx.content,
    cssPath: paths.cssPath,
    cssContent: css.content,
    storiesPath: paths.storiesPath,
    storiesContent: stories.content,
    indexPath: paths.indexPath,
    indexContent: `export { ${componentName} } from "./${componentName}";\nexport type { ${componentName}Props } from "./${componentName}";\n`,
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}

/**
 * The Storybook story id ("components-<name>--default") this module's
 * generated .stories.tsx always uses for its canonical "Default" story --
 * see generateStories's REQUIRED title/Default-story instructions above,
 * which force `title: "Components/${componentName}"` (componentName =
 * pascalCase(slug), computed the same way generateComponentCode does) and
 * a story exported as exactly `Default`.
 *
 * Storybook derives a story id by lowercasing each "/"-separated title
 * segment and stripping everything outside [a-z0-9-_], then joining with
 * "-" and appending "--" + the sanitized story export name. Since
 * componentName is PascalCase with no separators to strip (only case),
 * sanitizing it is equivalent to just lowercasing component.slug with its
 * own hyphens/underscores removed -- so this is derivable from
 * component.slug alone, with no need to inspect any generated file. Used
 * by the component detail page to embed a Storybook iframe (see
 * DESIGN_SYSTEM_STORYBOOK_URL in .env.example).
 */
export function storybookDefaultStoryId(slug: string): string {
  const sanitizedComponentName = pascalCase(slug).toLowerCase();
  return `components-${sanitizedComponentName}--default`;
}
