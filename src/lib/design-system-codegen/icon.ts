import { componentIdentifier, pascalCase, componentSourcePaths, type GeneratedComponentFiles } from "./paths";

/**
 * Deterministic (no-LLM) code generation for single-glyph SVG icons.
 *
 * Why icons don't go through the LLM pipeline (component.ts) the way real
 * components do: that pipeline feeds the model a distilled TEXT spec of the
 * Figma node (figma-node.ts), which carries sizes/fills/layout but NOT the
 * actual vector path geometry -- so for an icon the model has to HALLUCINATE
 * the `d` path and guess whether the glyph is stroke- or fill-drawn. That
 * guessing shipped broken icons: fill-based glyphs generated with the fill on
 * the wrong element (or left inheriting the root `fill="none"`) render totally
 * invisible, and no class-name check catches it because the class technically
 * exists (confirmed in production: OutlineRegularChevronright/up rendered as
 * blank canvases while the stroke-based Chevrondown happened to survive).
 *
 * Figma already renders the real, exact SVG for any node via its images API
 * (`format=svg`). So for icons we fetch that real SVG and wrap it
 * deterministically: no model call, no cost, no guessing, and every icon comes
 * out with identical structure. The only transform is making the glyph inherit
 * the surrounding text `color` (hardcoded fills/strokes -> `currentColor`) so a
 * single icon works on any background and in any theme -- the whole point of a
 * shared icon set.
 */

/** SVG presentation attributes whose hyphenated names must become camelCase in JSX. */
const ATTR_NAME_MAP: Record<string, string> = {
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset",
  "stroke-opacity": "strokeOpacity",
  "fill-opacity": "fillOpacity",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "clip-path": "clipPath",
  "flood-color": "floodColor",
  "flood-opacity": "floodOpacity",
  "color-interpolation-filters": "colorInterpolationFilters",
};

/**
 * A fill/stroke value is a "concrete color" (should become currentColor, so the
 * icon inherits the text color) UNLESS it's one of these structural keywords or
 * a paint-server reference (a gradient/pattern `url(#...)`, which must be kept).
 */
function isConcreteColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none" || v === "currentcolor" || v === "transparent" || v === "inherit") return false;
  if (v.startsWith("url(")) return false; // gradient/pattern paint server -- keep as-is
  return true;
}

/**
 * Turns a raw Figma-exported SVG string into JSX-ready pieces: the viewBox, the
 * root svg's own fill (sanitized), and the inner markup (paths/groups) with JSX
 * attribute names and color inheritance applied. Pure -- no I/O -- so it's unit-
 * testable against real Figma output.
 */
export function sanitizeSvg(svg: string): { viewBox: string; rootFill: string; inner: string } {
  const openMatch = svg.match(/<svg\b([^>]*)>/i);
  const rootAttrs = openMatch ? openMatch[1] : "";
  const viewBoxMatch = rootAttrs.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : "0 0 24 24";
  const rootFillMatch = rootAttrs.match(/\bfill\s*=\s*["']([^"']*)["']/i);
  const rootFill = rootFillMatch && isConcreteColor(rootFillMatch[1]) ? "currentColor" : rootFillMatch?.[1] ?? "none";

  // Inner = everything between the opening <svg ...> and the closing </svg>.
  let inner = svg
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, "")
    .replace(/<\/svg>[\s\S]*$/i, "")
    .trim();

  // Drop xmlns / xmlns:xlink declarations (not needed on inner JSX elements).
  inner = inner.replace(/\s+xmlns(:[a-z]+)?\s*=\s*["'][^"']*["']/gi, "");

  // Hyphenated presentation attribute names -> camelCase.
  for (const [from, to] of Object.entries(ATTR_NAME_MAP)) {
    inner = inner.replace(new RegExp(`(\\s)${from}(\\s*=)`, "gi"), `$1${to}$2`);
  }
  inner = inner.replace(/(\s)xlink:href(\s*=)/gi, "$1xlinkHref$2");
  inner = inner.replace(/(\s)class(\s*=)/gi, "$1className$2");

  // Hardcoded fill/stroke colors -> currentColor (keep none / gradients).
  inner = inner.replace(/\b(fill|stroke)\s*=\s*["']([^"']*)["']/gi, (m, prop, value) =>
    isConcreteColor(value) ? `${prop}="currentColor"` : m,
  );
  // Inline style="" is rare in Figma icon exports and would be an invalid JSX
  // string attribute anyway (JSX wants an object) -- strip it. A color declared
  // there would already have been covered by the fill/stroke pass above if it
  // were an attribute; icons don't rely on inline style for their glyph.
  inner = inner.replace(/\bstyle\s*=\s*["'][^"']*["']/gi, "");

  return { viewBox, rootFill, inner };
}

/**
 * Builds the full file set for one icon from its real Figma SVG. Same shape and
 * paths as the LLM component pipeline (componentSourcePaths / GeneratedComponentFiles)
 * so the codegen route commits it identically -- it just costs no tokens.
 */
export function buildIconComponentFiles(slug: string, svg: string): GeneratedComponentFiles {
  const paths = componentSourcePaths(slug, true);
  const fileBase = paths.componentName;
  const componentName = componentIdentifier(slug);
  const { viewBox, rootFill, inner } = sanitizeSvg(svg);

  const indent = (s: string) => s.split("\n").map((l) => (l.trim() ? `      ${l.trim()}` : "")).join("\n");

  const tsxContent =
    `import React from "react";\n` +
    `import styles from "./${fileBase}.module.scss";\n` +
    `\n` +
    `export interface ${componentName}Props extends React.SVGProps<SVGSVGElement> {\n` +
    `  /** Width and height in px (icons are square). Defaults to 24. */\n` +
    `  size?: number | string;\n` +
    `}\n` +
    `\n` +
    `/** Auto-generated from Figma -- the real exported SVG, colored via \`currentColor\`. */\n` +
    `export const ${componentName}: React.FC<${componentName}Props> = ({ size = 24, className, ...props }) => (\n` +
    `  <svg\n` +
    `    className={[styles.icon, className].filter(Boolean).join(" ")}\n` +
    `    width={size}\n` +
    `    height={size}\n` +
    `    viewBox="${viewBox}"\n` +
    `    fill="${rootFill}"\n` +
    `    xmlns="http://www.w3.org/2000/svg"\n` +
    `    {...props}\n` +
    `  >\n` +
    `${indent(inner)}\n` +
    `  </svg>\n` +
    `);\n`;

  const cssContent =
    `.icon {\n` +
    `  display: inline-block;\n` +
    `  vertical-align: middle;\n` +
    `  flex-shrink: 0;\n` +
    `}\n`;

  const storiesContent =
    `import type { Meta, StoryObj } from "@storybook/react";\n` +
    `import { ${componentName} as Component } from "./${fileBase}";\n` +
    `\n` +
    `const meta: Meta<typeof Component> = {\n` +
    `  title: "Icons/${componentName}",\n` +
    `  component: Component,\n` +
    `  args: { size: 24 },\n` +
    `};\n` +
    `export default meta;\n` +
    `\n` +
    `type Story = StoryObj<typeof Component>;\n` +
    `\n` +
    `export const Default: Story = {};\n` +
    `export const Large: Story = { args: { size: 48 } };\n`;

  const indexContent =
    `export { ${componentName} } from "./${fileBase}";\n` +
    `export type { ${componentName}Props } from "./${fileBase}";\n`;

  return {
    componentName,
    tsxPath: paths.tsxPath,
    tsxContent,
    cssPath: paths.cssPath,
    cssContent,
    storiesPath: paths.storiesPath,
    storiesContent,
    indexPath: paths.indexPath,
    indexContent,
    // Same legacy-file cleanup as generateComponentCode: a digit-leading slug
    // that previously filed under its (invalid-identifier) pascalCase name.
    deletePaths:
      pascalCase(slug) === fileBase
        ? []
        : [
            `${paths.dir}/${pascalCase(slug)}.tsx`,
            `${paths.dir}/${pascalCase(slug)}.module.scss`,
            `${paths.dir}/${pascalCase(slug)}.stories.tsx`,
          ],
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}
