import "server-only";
import { db } from "@/db";
import { designToken, designComponent, type DesignTokenCategory, type DesignComponentVariant, type DesignComponentState } from "@/db/schema";
import { figmaGet } from "./client";

/**
 * Pulls a Figma file's styles and components and upserts them into
 * design_token / design_component (see src/db/schema.ts). Field names below
 * are verified against Figma's REST API v1 OpenAPI spec
 * (github.com/figma/rest-api-spec) as of writing -- not guessed from memory.
 *
 * This is inherently best-effort: Figma files are visual documents, not a
 * structured design-token format, so resolving a style to a single CSS-ready
 * value (or a component's name to variant/state properties) relies on
 * common conventions (comma-separated "Property=Value" variant names, a
 * SOLID fill on some node using a FILL style, etc) that aren't guaranteed by
 * Figma's API schema. Anything that doesn't match a recognized shape is
 * skipped rather than guessed at -- see SyncResult.skipped.
 */

// ---- Figma file JSON (partial types -- only the fields this parser reads) ----

interface FigmaRGBA {
  r: number; // 0-1
  g: number; // 0-1
  b: number; // 0-1
  a: number; // 0-1
}

interface FigmaPaint {
  type: string; // "SOLID" | "GRADIENT_LINEAR" | "IMAGE" | ...
  visible?: boolean;
  opacity?: number;
  color?: FigmaRGBA;
}

interface FigmaTypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
}

interface FigmaEffect {
  type: string; // "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | ...
  visible?: boolean;
  radius?: number;
  color?: FigmaRGBA;
  offset?: { x: number; y: number };
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  styles?: Record<string, string>; // styleType-ish key -> style ID (see top-level `styles`)
  fills?: FigmaPaint[];
  style?: FigmaTypeStyle;
  effects?: FigmaEffect[];
  children?: FigmaNode[];
}

interface FigmaStyle {
  key: string;
  name: string;
  description?: string;
  styleType: "FILL" | "TEXT" | "EFFECT" | "GRID";
}

interface FigmaComponent {
  key: string;
  name: string;
  description?: string;
  componentSetId?: string;
}

interface FigmaComponentSet {
  key: string;
  name: string;
  description?: string;
}

interface FigmaFileResponse {
  document: FigmaNode;
  styles: Record<string, FigmaStyle>;
  components: Record<string, FigmaComponent>;
  componentSets: Record<string, FigmaComponentSet>;
}

// ---- Style value resolution ----

function rgbaToCss(c: FigmaRGBA, opacity = 1): string {
  const alpha = c.a * opacity;
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  if (alpha >= 0.999) {
    const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

function resolveFillValue(node: FigmaNode): string | undefined {
  const fill = (node.fills ?? []).find((f) => f.type === "SOLID" && f.visible !== false && f.color);
  if (!fill?.color) return undefined;
  return rgbaToCss(fill.color, fill.opacity ?? 1);
}

function resolveTextValue(node: FigmaNode): string | undefined {
  const s = node.style;
  if (!s?.fontFamily || !s.fontSize) return undefined;
  const weight = s.fontWeight ?? 400;
  const lineHeight = s.lineHeightPx ? `/${Math.round(s.lineHeightPx)}px` : "";
  return `${weight} ${Math.round(s.fontSize)}px${lineHeight} ${s.fontFamily}`;
}

function resolveEffectValue(node: FigmaNode): string | undefined {
  const effect = (node.effects ?? []).find(
    (e) => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible !== false && e.color,
  );
  if (!effect?.color) return undefined;
  const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
  const x = Math.round(effect.offset?.x ?? 0);
  const y = Math.round(effect.offset?.y ?? 0);
  const blur = Math.round(effect.radius ?? 0);
  return `${inset}${x}px ${y}px ${blur}px ${rgbaToCss(effect.color)}`;
}

const STYLE_TYPE_TO_CATEGORY: Record<string, DesignTokenCategory | undefined> = {
  FILL: "color",
  TEXT: "typography",
  EFFECT: "shadow",
  // GRID intentionally unmapped -- layout guides have no clean CSS-token
  // equivalent, skipped rather than guessed at.
};

interface ResolvedToken {
  category: DesignTokenCategory;
  value: string;
  figmaNodeId: string;
}

/** Iterative (not recursive) tree walk -- Figma documents can be deep/wide, avoid stack-depth risk. */
function resolveStylesFromDocument(
  document: FigmaNode,
  styles: Record<string, FigmaStyle>,
): Map<string, ResolvedToken> {
  const resolved = new Map<string, ResolvedToken>();
  const stack: FigmaNode[] = [document];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children) stack.push(...node.children);

    if (!node.styles) continue;
    for (const styleId of Object.values(node.styles)) {
      if (resolved.has(styleId)) continue;
      const style = styles[styleId];
      const category = style && STYLE_TYPE_TO_CATEGORY[style.styleType];
      if (!category) continue;

      let value: string | undefined;
      if (style.styleType === "FILL") value = resolveFillValue(node);
      else if (style.styleType === "TEXT") value = resolveTextValue(node);
      else if (style.styleType === "EFFECT") value = resolveEffectValue(node);

      if (value) resolved.set(styleId, { category, value, figmaNodeId: node.id });
    }
  }

  return resolved;
}

// ---- Component variant/state parsing ----

/** "Size=Large, State=Hover" -> [{key:"Size",value:"Large"},{key:"State",value:"Hover"}]. Not an
 *  officially-documented format (Figma's editor generates it, but no spec pins the syntax down) --
 *  falls back to treating the whole name as one variant if it doesn't match. */
function parseVariantName(name: string): { key: string; value: string }[] | null {
  const parts = name.split(",").map((p) => p.trim());
  const pairs = parts.map((p) => {
    const idx = p.indexOf("=");
    return idx === -1 ? null : { key: p.slice(0, idx).trim(), value: p.slice(idx + 1).trim() };
  });
  return pairs.every((p) => p !== null) ? (pairs as { key: string; value: string }[]) : null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "component"
  );
}

interface ResolvedComponentGroup {
  slug: string;
  name: string;
  description?: string;
  figmaNodeIds: string[];
  variants: DesignComponentVariant[];
  states: DesignComponentState[];
}

function buildComponentGroups(
  components: Record<string, FigmaComponent>,
  componentSets: Record<string, FigmaComponentSet>,
): ResolvedComponentGroup[] {
  const byComponentSetId = new Map<string, [string, FigmaComponent][]>();
  const standalone: [string, FigmaComponent][] = [];

  for (const entry of Object.entries(components)) {
    const [, component] = entry;
    if (component.componentSetId) {
      const list = byComponentSetId.get(component.componentSetId) ?? [];
      list.push(entry);
      byComponentSetId.set(component.componentSetId, list);
    } else {
      standalone.push(entry);
    }
  }

  const groups: ResolvedComponentGroup[] = [];
  const usedSlugs = new Set<string>();
  const uniqueSlug = (base: string) => {
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
    usedSlugs.add(slug);
    return slug;
  };

  for (const [setNodeId, set] of Object.entries(componentSets)) {
    const children = byComponentSetId.get(setNodeId) ?? [];
    const variantMap = new Map<string, DesignComponentVariant>();
    const stateMap = new Map<string, DesignComponentState>();

    for (const [, component] of children) {
      const pairs = parseVariantName(component.name);
      if (!pairs) {
        variantMap.set(component.name, { name: component.name });
        continue;
      }
      for (const { key, value } of pairs) {
        if (/state/i.test(key)) {
          stateMap.set(value, { name: value });
        } else {
          const label = `${key}: ${value}`;
          variantMap.set(label, { name: label });
        }
      }
    }

    groups.push({
      slug: uniqueSlug(slugify(set.name)),
      name: set.name,
      description: set.description || undefined,
      figmaNodeIds: [setNodeId, ...children.map(([nodeId]) => nodeId)],
      variants: Array.from(variantMap.values()),
      states: Array.from(stateMap.values()),
    });
  }

  for (const [nodeId, component] of standalone) {
    groups.push({
      slug: uniqueSlug(slugify(component.name)),
      name: component.name,
      description: component.description || undefined,
      figmaNodeIds: [nodeId],
      variants: [],
      states: [],
    });
  }

  return groups;
}

// ---- Entry point ----

export interface SyncResult {
  tokensUpserted: number;
  tokensSkipped: number;
  componentsUpserted: number;
}

export async function syncDesignSystemFromFigma(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
): Promise<SyncResult> {
  const file = await figmaGet<FigmaFileResponse>(`/files/${encodeURIComponent(fileKey)}`, accessToken);

  const resolvedStyles = resolveStylesFromDocument(file.document, file.styles);
  let tokensUpserted = 0;
  for (const [styleId, resolved] of resolvedStyles) {
    const meta = file.styles[styleId];
    await db
      .insert(designToken)
      .values({
        workspaceId,
        name: meta.name,
        category: resolved.category,
        value: resolved.value,
        description: meta.description || undefined,
        figmaNodeId: resolved.figmaNodeId,
      })
      .onConflictDoUpdate({
        target: [designToken.workspaceId, designToken.name],
        set: {
          category: resolved.category,
          value: resolved.value,
          description: meta.description || undefined,
          figmaNodeId: resolved.figmaNodeId,
          updatedAt: new Date(),
        },
      });
    tokensUpserted++;
  }
  const tokensSkipped = Object.keys(file.styles).length - resolvedStyles.size;

  const groups = buildComponentGroups(file.components, file.componentSets);
  let componentsUpserted = 0;
  for (const group of groups) {
    // Deliberately NOT touching `notes` in the update set -- that field is
    // for hand-written implementation notes (see the component detail
    // page), and a re-sync should never overwrite what a person wrote there.
    await db
      .insert(designComponent)
      .values({
        workspaceId,
        slug: group.slug,
        name: group.name,
        description: group.description,
        variants: group.variants,
        states: group.states,
        figmaNodeIds: group.figmaNodeIds,
      })
      .onConflictDoUpdate({
        target: [designComponent.workspaceId, designComponent.slug],
        set: {
          name: group.name,
          description: group.description,
          variants: group.variants,
          states: group.states,
          figmaNodeIds: group.figmaNodeIds,
          updatedAt: new Date(),
        },
      });
    componentsUpserted++;
  }

  return { tokensUpserted, tokensSkipped, componentsUpserted };
}
