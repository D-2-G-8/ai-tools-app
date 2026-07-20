import "server-only";
import { getFileNodes } from "@/lib/figma/client";
import { toCssVarName, type TokenForCss } from "./tokens";

/**
 * Turns a component's REAL Figma nodes into a compact, faithful text spec
 * that the codegen prompts feed to the model -- so a generated component
 * reproduces the actual design (sizes, radii, fills, layout, typography,
 * structure) instead of hallucinating it from variant labels alone.
 *
 * Why this exists: Figma sync (src/lib/figma/sync.ts) only stores metadata
 * (name, variant/state labels, node ids, tokens). The codegen used to pass
 * the model just those labels, so nothing it produced could match Figma.
 * This module fetches the node subtree over REST (getFileNodes, works in the
 * serverless codegen route the same as the metadata sync does) and distills
 * it. Same source of truth the Figma MCP reads -- just over the REST API,
 * which is the only channel available server-side.
 */

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}
interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
}
interface FigmaTypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
}
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: { width: number; height: number };
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  layoutMode?: "HORIZONTAL" | "VERTICAL" | "NONE";
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  characters?: string;
  style?: FigmaTypeStyle;
  componentPropertyDefinitions?: Record<string, { type: string; variantOptions?: string[] }>;
  // Present on INSTANCE nodes: the main component this instance was placed
  // from (used to detect composition -- see ComponentIndex) and the values
  // set on its component properties (what to pass as props).
  componentId?: string;
  componentProperties?: Record<string, { type: string; value: string | boolean }>;
}
export interface FigmaNodesResponse {
  nodes: Record<string, { document: FigmaNode } | null>;
}

/** A design-system component an INSTANCE can be composed from. */
export interface ComponentRef {
  slug: string;
  /** PascalCase(slug) -- the exported React component + import path segment. */
  componentName: string;
  isIcon: boolean;
}

/**
 * figmaNodeId -> the design_component that node belongs to. Built from every
 * component's figma_node_ids (see buildComponentIndex in dependencies.ts).
 * Lets the distiller recognize an INSTANCE as "compose component B" rather
 * than flattening B's internals into A.
 */
export type ComponentIndex = Map<string, ComponentRef>;

// Keep the distilled spec bounded so a huge component set (Avatar is 36
// variants of deep trees) can't blow the prompt budget. Depth 4 keeps the
// meaningful structure (Container -> content, icon instance + its size) while
// dropping the innermost vector/boolean leaves that add lines without design
// info. A normal component fits far under the line cap; only very large sets
// truncate, and the model can extrapolate the regular size progression.
const MAX_DEPTH = 4;
const MAX_LINES = 900;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** {r,g,b,a} in 0..1 -> "#rrggbb" (or "rgba(...)" when translucent). */
function colorToCss(c: FigmaColor): string {
  const to255 = (v: number) => Math.round(v * 255);
  const a = c.a ?? 1;
  if (a < 1) return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${round(a)})`;
  const hex = (v: number) => to255(v).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/** First visible solid fill of a node, as a CSS color string, or null. */
function solidFill(paints: FigmaPaint[] | undefined): string | null {
  const p = (paints ?? []).find((x) => x.type === "SOLID" && x.visible !== false && x.color);
  return p?.color ? colorToCss(p.color) : null;
}

/**
 * If a color exactly matches a synced token's value, render it as the token
 * reference (so the generated CSS uses var(--token) instead of a hardcoded
 * hex) -- otherwise the raw color, which the model can still map against the
 * token list generateCss is given.
 */
function withToken(color: string, tokenByValue: Map<string, string>): string {
  const name = tokenByValue.get(color.toLowerCase());
  return name ? `${color} (token --${name})` : color;
}

function radiusOf(node: FigmaNode): string | null {
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) return `${round(node.cornerRadius)}px`;
  const r = node.rectangleCornerRadii;
  if (r && r.some((v) => v > 0)) return r.map(round).join("/") + "px";
  return null;
}

/** "Size=40 px, Type=Icon" -> compact "Size=40 px, Type=Icon" for the spec. */
function instanceProps(node: FigmaNode): string {
  const props = node.componentProperties;
  if (!props) return "";
  const pairs = Object.entries(props)
    // property keys look like "Size#1686:0" -- strip the "#nodeId" suffix
    .map(([k, v]) => `${k.split("#")[0]}=${v.value}`);
  return pairs.length ? ` props(${pairs.join(", ")})` : "";
}

function distillNode(
  node: FigmaNode,
  tokenByValue: Map<string, string>,
  index: ComponentIndex,
  selfSlug: string,
  uses: Map<string, ComponentRef>,
  depth: number,
  lines: string[],
): void {
  if (lines.length >= MAX_LINES) return;

  // Composition: an INSTANCE of another design-system component. Emit a
  // "USE" marker and STOP -- do NOT flatten its internals, so the generated
  // code imports and renders that component instead of re-implementing it.
  // (Skip self-references, e.g. a component set instancing its own variant.)
  if (node.type === "INSTANCE" && node.componentId) {
    const ref = index.get(node.componentId);
    if (ref && ref.slug !== selfSlug) {
      uses.set(ref.slug, ref);
      const box = node.absoluteBoundingBox;
      lines.push(
        "  ".repeat(depth) +
          `USE <${ref.componentName}> (design-system component "${ref.slug}")` +
          (box ? ` ${round(box.width)}x${round(box.height)}` : "") +
          instanceProps(node),
      );
      return;
    }
  }

  const parts: string[] = [`${node.type} "${node.name}"`];

  const box = node.absoluteBoundingBox;
  if (box) parts.push(`${round(box.width)}x${round(box.height)}`);

  const radius = radiusOf(node);
  if (radius) parts.push(`radius:${radius}`);

  if (node.layoutMode && node.layoutMode !== "NONE") {
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
    parts.push(`layout:${node.layoutMode === "HORIZONTAL" ? "row" : "col"}`);
    if (node.itemSpacing) parts.push(`gap:${round(node.itemSpacing)}`);
    if (pad.some((p) => p)) parts.push(`pad:${pad.map((p) => round(p ?? 0)).join(" ")}`);
  }

  const fill = solidFill(node.fills);
  if (fill) parts.push(`fill:${withToken(fill, tokenByValue)}`);

  const stroke = solidFill(node.strokes);
  if (stroke) parts.push(`stroke:${withToken(stroke, tokenByValue)}${node.strokeWeight ? `@${round(node.strokeWeight)}px` : ""}`);

  if (typeof node.characters === "string") {
    parts.push(`text:${JSON.stringify(node.characters.slice(0, 40))}`);
    const s = node.style;
    if (s) {
      const font = [
        s.fontFamily,
        s.fontWeight && `w${s.fontWeight}`,
        s.fontSize && `${round(s.fontSize)}px`,
        s.lineHeightPx && `lh${round(s.lineHeightPx)}`,
        s.letterSpacing && `ls${round(s.letterSpacing)}`,
      ]
        .filter(Boolean)
        .join(" ");
      if (font) parts.push(`font:{${font}}`);
    }
  }

  lines.push("  ".repeat(depth) + parts.join(" "));

  if (depth < MAX_DEPTH && node.children) {
    for (const child of node.children) distillNode(child, tokenByValue, index, selfSlug, uses, depth + 1, lines);
  }
}

/** Distills one already-fetched node document into spec text. */
function distillDocument(
  doc: FigmaNode,
  tokenByValue: Map<string, string>,
  index: ComponentIndex,
  selfSlug: string,
  uses: Map<string, ComponentRef>,
): string {
  const lines: string[] = [];

  if (doc.componentPropertyDefinitions) {
    const props = Object.entries(doc.componentPropertyDefinitions)
      // Property keys look like "Size#1686:0" -- strip the "#nodeId" suffix.
      .map(([k, v]) => `${k.split("#")[0]}${v.variantOptions?.length ? `: ${v.variantOptions.join(" | ")}` : ` (${v.type})`}`)
      .join("; ");
    lines.push(`Component properties: ${props}`);
  }

  distillNode(doc, tokenByValue, index, selfSlug, uses, 0, lines);
  if (lines.length >= MAX_LINES) lines.push("... (truncated -- design larger than the spec budget)");
  return lines.join("\n");
}

export interface ComponentDesign {
  /** The distilled design spec text (fed into the generation prompts). */
  spec: string;
  /** Design-system components this one composes (INSTANCE nodes) -- the
   *  generated code imports and renders these instead of re-implementing them. */
  uses: ComponentRef[];
}

/**
 * Fetches the component's real Figma nodes and returns a compact design spec
 * string, or null if there's nothing to fetch / the fetch fails (codegen
 * then falls back to label-only generation rather than erroring the run).
 */
export async function fetchComponentDesignSpec(
  fileKey: string,
  nodeIds: string[],
  accessToken: string,
  tokens: TokenForCss[],
  index: ComponentIndex,
  selfSlug: string,
): Promise<ComponentDesign | null> {
  const primary = nodeIds.slice(0, 1); // the component (set) root; its subtree covers the variants
  if (primary.length === 0) return null;

  // Key by color value -> sanitized CSS var name (matching tokens.css), so the
  // annotation the model sees is the exact var() it should emit.
  const tokenByValue = new Map<string, string>();
  for (const t of tokens) {
    const v = t.value.trim().toLowerCase();
    if (v && !tokenByValue.has(v)) tokenByValue.set(v, toCssVarName(t.name));
  }

  const uses = new Map<string, ComponentRef>();
  const res = await getFileNodes<FigmaNodesResponse>(fileKey, primary, accessToken);
  const specs: string[] = [];
  for (const id of primary) {
    const doc = res.nodes[id]?.document;
    if (doc) specs.push(distillDocument(doc, tokenByValue, index, selfSlug, uses));
  }
  const spec = specs.join("\n\n").trim();
  if (!spec) return null;
  return { spec, uses: [...uses.values()] };
}
