import "server-only";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getAnthropicClient } from "@/lib/llm/client";
import { estimateCostUsd } from "@/lib/models";
import type { DesignComponentVariant, DesignComponentState } from "@/db/schema";
import { toCssVarName, type TokenForCss } from "./tokens";
import {
  pascalCase,
  componentIdentifier,
  componentSourcePaths,
  storybookDefaultStoryId,
  type ComponentSourcePaths,
  type GeneratedComponentFiles,
} from "./paths";
import {
  checkClassNamesMatch,
  checkStoriesNoNameCollision,
  type ClassNameCheckResult,
  type StoriesCheckResult,
} from "./checks";
import { reviewAndFix } from "./review";
import type { Finding, FileKind, GeneratedFiles, ReviewContext } from "./review";

// Re-exported so existing `from ".../component"` import sites keep working after
// these pure helpers moved to ./paths (which has no server-only, so icon.ts and
// unit tests can use them without dragging in this module's LLM/db imports).
export {
  pascalCase,
  componentIdentifier,
  componentSourcePaths,
  storybookDefaultStoryId,
  type ComponentSourcePaths,
  type GeneratedComponentFiles,
};

// Re-exported so existing `from ".../component"` import sites keep working after
// these pure checks moved to ./checks (which has no server-only, so review/
// deterministic.ts and unit tests can use them without dragging in this
// module's LLM/db imports). Imported (not `export ... from`) so this module's
// own internal calls below (generateComponentCode) still resolve them.
export {
  checkClassNamesMatch,
  checkStoriesNoNameCollision,
  type ClassNameCheckResult,
  type StoriesCheckResult,
};

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
  /**
   * True for a single-glyph SVG icon (design_component.isIcon, set by Figma
   * sync's isLikelyIconName heuristic). Icons are generated into a separate
   * `src/icons/<slug>/` folder and grouped under Storybook's "Icons/" section
   * instead of "Components/" -- everything else about the pipeline is the same.
   */
  isIcon: boolean;
  /**
   * Compact spec of the component's REAL Figma design (per-variant sizes,
   * radii, fills, layout, typography, structure), distilled from the node
   * subtree over REST -- see fetchComponentDesignSpec in figma-node.ts. When
   * present, generation reproduces the actual design instead of guessing from
   * variant labels. Optional: if the node fetch is unavailable (no Figma
   * token / file key), generation falls back to label-only, same as before.
   */
  designSpec?: string;
  /**
   * Design-system components this one COMPOSES -- the design spec marks their
   * spots as `USE <ComponentName>`. The generated TSX imports each from its
   * sibling module (`../<slug>`) and renders it, instead of re-implementing
   * it. These must already be generated (the codegen orchestrator emits them
   * in dependency order -- see dependencies.ts).
   */
  uses?: { slug: string; componentName: string; isIcon: boolean }[];
}

const contractSchema = z.object({
  props: z
    .array(
      z.object({
        name: z.string().describe("camelCase prop name, e.g. \"size\" or \"disabled\"."),
        type: z.string().describe('TypeScript type as a string, e.g. "\'sm\' | \'md\' | \'lg\'" or "boolean".'),
        description: z
          .string()
          .describe(
            "REQUIRED, one clear sentence for a developer consuming this component: what the prop controls AND " +
              "when to pass vs omit it. Be concrete about defaults and the controlled/uncontrolled split -- e.g. " +
              "\"Controlled open state; pass together with onOpenChange to drive it from the parent, or omit both to " +
              "let the component manage its own open/closed state.\" or \"Initial open state when uncontrolled; " +
              "ignored if `open` is provided.\" Never leave this blank or generic ('the size prop').",
          ),
      }),
    )
    .describe(
      "Props derived from this component's Figma variants/states. Group related variants into one " +
        'enum-typed prop where sensible (e.g. "Size: Small"/"Size: Large" variants become one `size` prop). ' +
        "For an INTERACTIVE toggle state (e.g. an Opened On/Off variant on an accordion, a Checked variant on a " +
        "checkbox/switch, a Selected variant on a chip/tab), do NOT emit a single required boolean. Emit the " +
        "standard controlled/uncontrolled hybrid TRIO so a parent UI can both drive it and observe changes: an " +
        "OPTIONAL controlled value `open?: boolean` (natural name -- `checked`, `selected`...), an optional " +
        "`defaultOpen?: boolean` initial value, and a callback `onOpenChange?: (open: boolean) => void` fired on " +
        "every toggle. (The TSX keeps internal state seeded from the default and uses `open ?? internal` as the " +
        "effective value.) Non-interactive display states (disabled, error, loading, size, variant) stay plain props.",
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
        "styles.<name>. MUST be camelCase single identifiers -- NO hyphens, NO BEM `--`/`__` (e.g. " +
        '"buttonPrimary", never "button-primary", "avatar--24", or "avatar__container"). The TSX accesses ' +
        "them as styles.<name> (dot), which is invalid for hyphenated names, so every variant/size/state must " +
        "be its OWN camelCase class here (e.g. sizeSm, sizeMd, typeIcon, squared, withBadge) -- never a " +
        "hyphenated or BEM modifier. TSX and CSS both copy this exact list character-for-character.",
    ),
});

type ComponentContract = z.infer<typeof contractSchema>;

function describeComponent(component: ComponentForCodegen): string {
  const variantLines = component.variants.map((v) => `- ${v.name}${v.description ? ` -- ${v.description}` : ""}`);
  const stateLines = component.states.map((s) => `- ${s.name}${s.description ? ` -- ${s.description}` : ""}`);
  return [
    `Component name: ${component.name}`,
    component.description ? `Description: ${component.description}` : "",
    variantLines.length ? `Variants (from Figma):\n${variantLines.join("\n")}` : "No variants.",
    stateLines.length ? `States (from Figma):\n${stateLines.join("\n")}` : "No states.",
    // The real design, distilled from the Figma node subtree. This is the
    // source of truth for the implementation -- exact px sizes, corner radii,
    // fill colors, auto-layout, and typography per variant. When present,
    // reproduce it faithfully; do NOT invent dimensions/colors/structure.
    component.designSpec
      ? "Actual Figma design (REPRODUCE THIS EXACTLY -- indentation = node nesting; " +
        "WxH in px, radius/gap/pad in px, fill/stroke are CSS colors, font:{...} is typography):\n" +
        component.designSpec
      : "",
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
  fileBase: string,
  reviewFeedback?: string,
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
      `CSS Modules class names available (import from "./${fileBase}.module.scss" as \`styles\`, reference ONLY via styles.<name>, exactly these names): ${contract.classNames.join(", ")}`,
      component.uses && component.uses.length > 0
        ? "\nThis component COMPOSES other design-system components -- the design spec marks their spots as " +
          "`USE <Name>`. For each, IMPORT it using EXACTLY the path below and RENDER it there; do NOT re-implement " +
          "its markup/SVG/styles, and do NOT change the import path. Available components:\n" +
          component.uses
            .map((u) => {
              // Components live in src/components/<slug>, icons in src/icons/<slug>.
              // From this component's dir the path to a same-kind dependency is
              // "../<slug>"; to a different-kind one it must cross folders.
              const path =
                u.isIcon === component.isIcon
                  ? `../${u.slug}`
                  : `../../${u.isIcon ? "icons" : "components"}/${u.slug}`;
              return `- import { ${u.componentName} } from "${path}";`;
            })
            .join("\n") +
          "\nPass the instance's props(...) from the spec through to the component's props as sensible. " +
          "CRITICAL: wherever the spec says `USE <X>`, you MUST import and render the REAL <X/> there. Do NOT " +
          "substitute a generic slot prop (e.g. `icon?: React.ReactNode`) for the caller to fill, do NOT render an " +
          "arbitrary inline `<svg>`, and do NOT drop an empty placeholder (`<span/>`) in its place -- all three are " +
          "failures to compose. If which instance to render depends on THIS component's own variant (e.g. a 24px vs " +
          "16px icon per button size, or an open vs closed chevron), branch on the variant and render the correct " +
          "real component with the correct props -- still never a generic slot."
        : "",
      "",
      "Requirements:",
      `- Named export \`${componentName}\`, plus an exported \`${componentName}Props\` interface.`,
      "- In the `" +
        componentName +
        "Props` interface, put a JSDoc `/** ... */` comment ABOVE EVERY prop, taken from that prop's description below -- say what it controls and when to pass vs omit it (and for a controlled/uncontrolled prop, which mode it's for). Storybook's docgen reads these JSDoc comments and shows them in the component's args/Controls table, so a developer consuming the component understands each prop without reading the source. Do not leave any prop undocumented.",
      "- If an \"Actual Figma design\" block is given above, reproduce its DOM structure and per-variant behavior faithfully (the same nesting of container/content/badge elements, the same size/type/state branching) -- don't invent a different structure.",
      "- EVERY prop above comes from a real Figma variant/state, so EVERY prop MUST visibly change what renders -- the way those variants actually differ in the design block. An enum prop (size/type/variant/position) branches the classes or markup; a boolean prop (opened/checked/selected/disabled/error/active/loading) applies the exact visual change its variants show: a rotation/flip, a different color/fill/border, a shown-vs-hidden element, a moved or reordered element, a swapped icon direction. A prop the component destructures but that never changes the output (beyond gating a child's presence) is a BUG -- consuming `opened` to render the body but leaving the chevron identical open vs closed is exactly this failure. If the design block shows how a variant differs, implement that difference; leave NO prop visually inert.",
      "- Apply each such state-driven change through EXACTLY ONE mechanism -- never two that compound. Two ways this bites: (a) the SAME transform in both an inline `style={{ transform: ... }}` AND a CSS rule (180deg + 180deg = 360deg, so it visibly doesn't move); and (b) swapping to a DIFFERENT icon per state AND rotating it. If the design uses distinct glyphs per state and you compose them (e.g. `<ChevronDown/>` when closed, `<ChevronUp/>` when open), that icon ALREADY points the right way -- do NOT also add a CSS `rotate` to it, or the rotation fights the swap (an up-chevron rotated 180deg looks like a down-chevron again, exactly the bug it seems fixed but isn't). CHOOSE ONE: either swap the icon per state and add NO rotation, OR render a single fixed icon and rotate it via one CSS class. Prefer the icon swap when the design provides both glyphs as separate components.",
      "- Drive POINTER states (hover / active / focus / focus-visible) purely with CSS pseudo-classes in the stylesheet (`&:hover`, `&:active`, `&:focus-visible`). Do NOT ALSO track them in React state -- no `isHovered`/`isActive` `useState` with `onMouseEnter`/`onMouseDown` handlers toggling `.stateHover`/`.stateActive` classes. Mirroring a pointer state in both JS and CSS is the same double-mechanism failure (and re-renders on every hover). Reserve React state strictly for LOGICAL state the user toggles (open/checked/selected -- the hybrid controlled/uncontrolled props above).",
      "- When a boolean state is INTERACTIVE (an accordion opening/closing, an expandable panel, a checkbox/switch/toggle, a selectable chip/tab), implement the STANDARD controlled/uncontrolled hybrid so the component both works on its own AND can be driven by a parent UI. Concretely, for a state called `open` (use the natural name -- `checked`, `selected`, `value`, etc.):",
      "    * `open?: boolean` -- OPTIONAL controlled value. When the parent passes it, it WINS: render from it and do not use internal state for display.",
      "    * `defaultOpen?: boolean` -- optional initial value for the uncontrolled case.",
      "    * `onOpenChange?: (open: boolean) => void` -- called on EVERY user toggle with the NEXT value, so the parent always learns the new state (whether controlled or not).",
      "    * internal `const [openState, setOpenState] = React.useState(defaultOpen ?? false)`; the effective value is `open ?? openState`.",
      "    * on the click/change handler: compute `next = !effective`; if uncontrolled (`open === undefined`) call `setOpenState(next)`; ALWAYS call `onOpenChange?.(next)`.",
      "  This means: with no props it still toggles on click (uncontrolled default -- never inert in Storybook or a first drop-in); a parent can fully control it via `open` + `onOpenChange`; and the parent always receives state changes. Drive the visual (rotate the chevron, show/hide the body, show the check) from the EFFECTIVE value. Do NOT make it controlled-only (a required value + required handler), and do NOT make it internal-only (no way for a parent to control or observe it). Apply this same hybrid to every interactive boolean.",
      "- Extend the appropriate native HTML element attributes type where sensible (e.g. ButtonHTMLAttributes for a button).",
      "- Reference styles ONLY via styles.<name>, copying each class name from the list above character-for-character (they are camelCase, so always dot access `styles.foo` -- never `styles['a-b']`, never a name not in the list). Never invent a class, never use inline styles for static styling, never hardcode a color/size value.",
      "- If a section only renders when a boolean prop is true (e.g. `{opened && <div className={styles.body}>...}`), a CSS open/close TRANSITION on that element is dead code (it mounts already-open). Either always render it and toggle an `open` class, or don't write a transition for it.",
      "- No default export.",
      reviewFeedback
        ? "\nA prior version of THIS file failed review. You MUST fix ALL of these and change nothing else that was already correct:\n" +
          reviewFeedback
        : "",
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
  reviewFeedback?: string,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const tokenByName = new Map(availableTokens.map((t) => [t.name, t]));
  const chosenTokens = contract.cssVariables
    .map((name) => tokenByName.get(name))
    .filter((t): t is TokenForCss => Boolean(t));

  const anthropic = await getAnthropicClient();
  const result = await generateText({
    model: anthropic(model),
    system:
      "You write CSS Modules stylesheets in SCSS syntax for a shared component library. Output ONLY the raw " +
      ".module.scss file contents -- no markdown code fences, no explanation before or after. Valid SCSS " +
      "(nesting, &-modifiers, etc.) is allowed and encouraged, but every class the component references must " +
      "still resolve to a top-level exported class name.",
    prompt: [
      describeComponent(component),
      "",
      `Write a rule for EVERY one of these class names, copied character-for-character, all camelCase (e.g. .buttonPrimary) -- do NOT rename to kebab-case or BEM, do NOT add or drop any, and do NOT leave any without its own selector (even a boolean/marker modifier like .withBadge MUST get a rule, even if minimal): ${contract.classNames.join(", ")}. You MAY additionally combine them in compound/nested selectors (e.g. \`.squared.sizeMd\`, \`.avatar .badge\`) for variant-specific rules, but every class token used must be one of these exact names.`,
      "Each variant/state class must actually ENCODE the visual DIFFERENCE that variant shows in the design (its own color/rotation/border/size/position), NOT an empty rule or one identical to the base state -- a state class that renders the same as the base makes that prop do nothing. E.g. an `.opened` class should carry the transform/height/etc. that the opened variant differs by; a `.selected`/`.error`/`.disabled` class should carry its distinct color/border/opacity from the design.",
      "If an \"Actual Figma design\" block is given above, match its exact px dimensions, corner radii, gaps/padding, and per-variant typography -- these are the real measured values, use them.",
      `Reference color/shadow values ONLY via the EXACT var() names below (they match the generated tokens.css; CSS custom properties are case-sensitive, so copy each var(--...) verbatim). Never a hardcoded color/shadow value, never a token not in this list; px sizes/radii/gaps from the design block are written directly:`,
      chosenTokens.map((t) => `- var(--${toCssVarName(t.name)}) (${t.category}) = ${t.value}`).join("\n") || "(no tokens chosen)",
      reviewFeedback
        ? "\nA prior version of THIS file failed review. You MUST fix ALL of these and change nothing else that was already correct:\n" +
          reviewFeedback
        : "",
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
  fileBase: string,
  reviewFeedback?: string,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  // Icons get their own "Icons/" Storybook section (mirrors the src/icons/
  // folder split and the app's separate Icons tab); everything else is a
  // "Components/" story. storybookDefaultStoryId derives the id from the
  // same rule, so the detail page's deep-link stays correct.
  const section = component.isIcon ? "Icons" : "Components";
  const anthropic = await getAnthropicClient();
  const result = await generateText({
    model: anthropic(model),
    system:
      "You write Storybook CSF3 stories (@storybook/react, TypeScript) for a shared component library. " +
      "Output ONLY the raw .stories.tsx file contents -- no markdown code fences, no explanation.",
    prompt: [
      describeComponent(component),
      "",
      `Component: ${componentName}, imported from "./${fileBase}" (a barrel that re-exports it).`,
      `Props (name: type -- description):\n${contract.props.map((p) => `- ${p.name}: ${p.type}${p.description ? ` -- ${p.description}` : ""}`).join("\n")}`,
      "In `meta`, include an `argTypes` map with an entry for EVERY prop above, each carrying a `description` " +
        "(the prop's description text above -- what it controls and when to pass/omit it) so the Storybook Controls/Docs " +
        "table documents every prop for the developer. For enum props also set `control: { type: \"select\" }` with the " +
        "exact literal `options`, and for booleans `control: \"boolean\"`. Example: " +
        '`argTypes: { open: { description: "Controlled open state; pass with onOpenChange to drive from the parent, or omit both for uncontrolled.", control: "boolean" } }`.',
      "",
      "Follow this exact structure (adjust component/args/stories to this component, but keep `title` and " +
        "the `Default` story EXACTLY as shown -- the platform deep-links to this specific story id):",
      "```",
      'import type { Meta, StoryObj } from "@storybook/react";',
      'import { Button as Component } from "./Button";',
      "",
      "const meta: Meta<typeof Component> = {",
      `  title: "${section}/${componentName}",`,
      "  component: Component,",
      '  args: { children: "Button" },',
      "};",
      "export default meta;",
      "",
      "type Story = StoryObj<typeof Component>;",
      "",
      "export const Default: Story = {};",
      'export const Primary: Story = { args: { variant: "primary" } };',
      "```",
      `REQUIRED: title must be exactly "${section}/${componentName}", and there must be exactly one story ` +
        'exported as `Default` (using the component\'s default args, like the example above) -- this is the ' +
        "canonical story the component detail page embeds. Beyond that, add one story per meaningfully " +
        "distinct variant/state combination -- don't enumerate every possible cross-product if that would " +
        "be excessive, use judgment for what's useful to preview.",
      "If the component is INTERACTIVE (toggles/expands/checks on click -- it manages its own state), the `Default` " +
        "story must let that interaction happen: render it plainly and do NOT freeze it by hard-pinning the state prop " +
        "with no way to change it. The reader must be able to click and watch it expand/collapse or toggle. Provide the " +
        "content it needs to show something meaningful when open (e.g. a title and some body text/children).",
      "",
      "Import ONLY from \"./" +
        componentName +
        "\" -- do NOT import any other package (no icon libraries like react-icons, @heroicons, lucide, etc.; " +
        "they are NOT dependencies and break the Storybook build). For a ReactNode/icon-typed prop, pass a small " +
        "inline `<svg width={16} height={16}>...</svg>` or omit it. In args/argTypes use ONLY the exact literal " +
        "values from the prop types above (e.g. if `size: \"24\" | \"32\"`, the control options are \"24\"/\"32\", " +
        "never invented ones like \"sm\"/\"md\").",
      "",
      `ALWAYS import the component under the alias "Component", exactly as shown above (\`import { ${componentName} as Component } from "./${fileBase}"\`) -- ` +
        "never under its own bare name. A story is always exported as `Default`, and some components may also " +
        `end up with a variant/state story that happens to share the component's own name (e.g. a component ` +
        'called "Default" or "Primary") -- importing the component bare in that case declares two top-level ' +
        "bindings with the same identifier in one module, which Babel refuses to parse at all (confirmed in " +
        "production: a component named \"Default\" broke the whole Storybook build this way). Aliasing the " +
        "import to a fixed, neutral name sidesteps this category of collision entirely, regardless of what the " +
        "component itself is named.",
      reviewFeedback
        ? "\nA prior version of THIS file failed review. You MUST fix ALL of these and change nothing else that was already correct:\n" +
          reviewFeedback
        : "",
    ].join("\n"),
  });
  return {
    content: stripCodeFence(result.text),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  };
}

/**
 * Generates one component's full file set. Throws (does not commit
 * anything itself -- that's the caller's job, see the codegen route) if
 * the deterministic class-name check or the stories name-collision check
 * fails, since committing mismatched TSX/CSS would ship a component that
 * renders unstyled, and committing a colliding stories file would break
 * the whole Storybook build for everyone, not just this one component.
 */
export async function generateComponentCode(
  model: string,
  component: ComponentForCodegen,
  availableTokens: TokenForCss[],
): Promise<GeneratedComponentFiles & { contract: ComponentContract }> {
  // Computed from the slug rather than asked of the LLM (the contract
  // schema used to have a `componentName` field) -- this makes the
  // Storybook story id ("components-<sanitized componentName>--default")
  // fully derivable from component.slug alone, which is what the
  // component detail page's Storybook iframe link needs (see
  // src/app/(protected)/design-system/components/[slug]/page.tsx).
  const paths = componentSourcePaths(component.slug, component.isIcon);
  const fileBase = paths.componentName; // the file name (may start with a digit -- valid as a path)
  const componentName = componentIdentifier(component.slug); // the JS identifier (never starts with a digit)
  const { contract, inputTokens: t1, outputTokens: o1 } = await generateContract(model, component, availableTokens);

  const [tsx, css, stories] = await Promise.all([
    generateTsx(model, component, contract, componentName, fileBase),
    generateCss(model, component, contract, availableTokens),
    generateStories(model, component, contract, componentName, fileBase),
  ]);

  const check = checkClassNamesMatch(tsx.content, css.content);
  if (!check.ok) {
    throw new Error(
      `Generated ${componentName}: TSX references CSS Modules classes not defined in the stylesheet -- ` +
        `${check.missingClasses.join(", ")}. Not committing a mismatched component.`,
    );
  }

  const storiesCheck = checkStoriesNoNameCollision(stories.content, componentName);
  if (!storiesCheck.ok) {
    throw new Error(`Generated ${componentName}: ${storiesCheck.reason}`);
  }

  const inputTokens = t1 + tsx.inputTokens + css.inputTokens + stories.inputTokens;
  const outputTokens = o1 + tsx.outputTokens + css.outputTokens + stories.outputTokens;

  return {
    contract,
    componentName,
    tsxPath: paths.tsxPath,
    tsxContent: tsx.content,
    cssPath: paths.cssPath,
    cssContent: css.content,
    storiesPath: paths.storiesPath,
    storiesContent: stories.content,
    indexPath: paths.indexPath,
    indexContent: `export { ${componentName} } from "./${fileBase}";\nexport type { ${componentName}Props } from "./${fileBase}";\n`,
    // Legacy files from when a digit-leading slug filed under its pascalCase
    // name (an invalid identifier); the file base is now componentIdentifier,
    // so remove the old-named tsx/scss/stories to avoid orphaned duplicates.
    deletePaths:
      pascalCase(component.slug) === fileBase
        ? []
        : [
            `${paths.dir}/${pascalCase(component.slug)}.tsx`,
            `${paths.dir}/${pascalCase(component.slug)}.module.scss`,
            `${paths.dir}/${pascalCase(component.slug)}.stories.tsx`,
          ],
    inputTokens,
    outputTokens,
    costUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}

/**
 * Same as generateComponentCode, but runs the generated files through the
 * review layer (deterministic gates + LLM DoD review + targeted
 * regeneration) before returning. The regeneration closures reuse the SAME
 * contract the first pass produced, so class/prop names stay stable across
 * review iterations instead of drifting into new mismatches.
 */
export async function generateComponentCodeReviewed(
  model: string,
  component: ComponentForCodegen,
  availableTokens: TokenForCss[],
): Promise<GeneratedComponentFiles & { reviewFindings: Finding[]; reviewPassed: boolean }> {
  const base = await generateComponentCode(model, component, availableTokens);

  const paths = componentSourcePaths(component.slug, component.isIcon);
  const componentName = componentIdentifier(component.slug);
  const fileBase = paths.componentName;
  const contract = base.contract; // reuse the SAME contract (stable names)

  const ctx: ReviewContext = {
    componentName,
    fileBase,
    tokenVarNames: new Set(availableTokens.map((t) => toCssVarName(t.name)).filter(Boolean)),
  };

  const files: GeneratedFiles = {
    tsx: base.tsxContent,
    css: base.cssContent,
    stories: base.storiesContent,
    index: base.indexContent,
  };

  const regenerateFile = async (kind: FileKind, feedback: string): Promise<{ content: string; inputTokens: number; outputTokens: number }> => {
    if (kind === "tsx") {
      const r = await generateTsx(model, component, contract, componentName, fileBase, feedback);
      return { content: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
    if (kind === "css") {
      const r = await generateCss(model, component, contract, availableTokens, feedback);
      return { content: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
    if (kind === "stories") {
      const r = await generateStories(model, component, contract, componentName, fileBase, feedback);
      return { content: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
    }
    return { content: files[kind], inputTokens: 0, outputTokens: 0 };
  };

  const review = await reviewAndFix({
    model,
    files,
    ctx,
    spec: component.designSpec,
    regenerateFile,
  });

  const totalInput = base.inputTokens + review.inputTokens;
  const totalOutput = base.outputTokens + review.outputTokens;

  return {
    ...base,
    tsxContent: review.files.tsx,
    cssContent: review.files.css,
    storiesContent: review.files.stories,
    indexContent: review.files.index,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    costUsd: estimateCostUsd(model, totalInput, totalOutput),
    reviewFindings: review.findings,
    reviewPassed: review.passed,
  };
}
