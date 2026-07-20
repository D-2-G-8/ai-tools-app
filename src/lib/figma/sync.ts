import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { designToken, designComponent, type DesignTokenCategory, type DesignComponentVariant, type DesignComponentState } from "@/db/schema";
import { figmaGet, FIGMA_FILE_FETCH_TIMEOUT_MS } from "./client";

/**
 * Pulls a Figma file's styles and components and upserts them into
 * design_token / design_component (see src/db/schema.ts). Field names below
 * are verified against Figma's REST API v1 OpenAPI spec
 * (github.com/figma/rest-api-spec) as of writing -- not guessed from memory.
 *
 * Two strategies, tried in order:
 *
 * 1. FAST PATH (tryFastSync): if the file is published as a Figma library,
 *    GET /v1/files/:key/{styles,components,component_sets} give the full
 *    list of everything to sync WITHOUT walking the document tree -- small,
 *    fast responses. Resolving each style's actual value (and each
 *    component set's variant children) still needs node data, but only for
 *    those specific node IDs, fetched via a handful of BATCHED
 *    GET /v1/files/:key/nodes?ids=a,b,c,... calls (as many IDs per call as
 *    fit comfortably in a URL) rather than one request per item -- Figma's
 *    Tier 1 endpoints (this one included) allow as few as ~10-20
 *    requests/minute on some plans, so "one request per component" for a
 *    file with dozens of components would itself get rate-limited.
 *
 * 2. FALLBACK (syncViaFullFileWalk): if the lightweight listing endpoints
 *    come back completely empty -- the file isn't published as a library --
 *    fall back to fetching the whole file (GET /v1/files/:key) and walking
 *    its document tree, the original (slower, but always-correct) approach.
 *
 * This is inherently best-effort: Figma files are visual documents, not a
 * structured design-token format, so resolving a style to a single CSS-ready
 * value (or a component's name to variant/state properties) relies on
 * common conventions (comma-separated "Property=Value" variant names, a
 * SOLID fill on some node using a FILL style, etc) that aren't guaranteed by
 * Figma's API schema. Anything that doesn't match a recognized shape is
 * skipped rather than guessed at -- see SyncResult.tokensSkipped.
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

// ---- Lightweight "published library" listing endpoints (fast path) ----

interface FigmaFrameInfo {
  name?: string;
  pageId?: string;
  pageName?: string;
}

interface FigmaPublishedStyle {
  node_id: string;
  style_type: "FILL" | "TEXT" | "EFFECT" | "GRID";
  name: string;
  description?: string;
}

interface FigmaPublishedComponent {
  node_id: string;
  name: string;
  description?: string;
  containing_frame?: FigmaFrameInfo;
}

interface FigmaPublishedComponentSet {
  node_id: string;
  name: string;
  description?: string;
  containing_frame?: FigmaFrameInfo;
}

interface FigmaFileStylesResponse {
  meta: { styles: FigmaPublishedStyle[] };
}

interface FigmaFileComponentsResponse {
  meta: { components: FigmaPublishedComponent[] };
}

interface FigmaFileComponentSetsResponse {
  meta: { component_sets: FigmaPublishedComponentSet[] };
}

interface FigmaFileNodesResponse {
  nodes: Record<string, { document: FigmaNode } | undefined>;
}

// ---- Style value resolution (shared by both paths) ----

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

function resolveStyleValue(category: DesignTokenCategory, node: FigmaNode): string | undefined {
  if (category === "color") return resolveFillValue(node);
  if (category === "typography") return resolveTextValue(node);
  if (category === "shadow") return resolveEffectValue(node);
  return undefined;
}

/** Iterative (not recursive) tree walk -- Figma documents can be deep/wide, avoid stack-depth risk.
 *  Only used by the full-file fallback path. */
function resolveStylesFromDocumentTree(
  document: FigmaNode,
  styles: Record<string, FigmaStyle>,
): Map<string, { category: DesignTokenCategory; value: string; figmaNodeId: string }> {
  const resolved = new Map<string, { category: DesignTokenCategory; value: string; figmaNodeId: string }>();
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
      const value = resolveStyleValue(category, node);
      if (value) resolved.set(styleId, { category, value, figmaNodeId: node.id });
    }
  }

  return resolved;
}

// ---- Batched node fetching (fast path) ----

const NODE_BATCH_SIZE = 250; // keeps request URLs well under typical length limits
const NODE_BATCH_CONCURRENCY = 3; // deliberately conservative -- see file-level comment on rate limits

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchNodesBatched(fileKey: string, accessToken: string, nodeIds: string[]): Promise<Map<string, FigmaNode>> {
  const result = new Map<string, FigmaNode>();
  const uniqueIds = Array.from(new Set(nodeIds.filter(Boolean)));
  if (uniqueIds.length === 0) return result;

  const batches = chunk(uniqueIds, NODE_BATCH_SIZE);
  for (let i = 0; i < batches.length; i += NODE_BATCH_CONCURRENCY) {
    const slice = batches.slice(i, i + NODE_BATCH_CONCURRENCY);
    const responses = await Promise.all(
      slice.map((ids) =>
        figmaGet<FigmaFileNodesResponse>(
          `/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids.map(encodeURIComponent).join(",")}`,
          accessToken,
          FIGMA_FILE_FETCH_TIMEOUT_MS,
        ),
      ),
    );
    for (const res of responses) {
      for (const [nodeId, entry] of Object.entries(res.nodes)) {
        if (entry?.document) result.set(nodeId, entry.document);
      }
    }
  }
  return result;
}

// ---- Component variant/state parsing + grouping (shared by both paths) ----

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

interface NormalizedComponentSet {
  nodeId: string;
  name: string;
  description?: string;
  pageLabel?: string; // for disambiguating multiple sets that share a literal name -- see below
  variantNodes: { id: string; name: string }[];
}

interface NormalizedStandaloneComponent {
  nodeId: string;
  name: string;
  description?: string;
  pageLabel?: string;
}

interface ResolvedComponentGroup {
  slug: string;
  name: string;
  description?: string;
  figmaNodeIds: string[];
  variants: DesignComponentVariant[];
  states: DesignComponentState[];
  isIcon: boolean;
}

/**
 * Best-effort "is this a single icon rather than a real UI component"
 * heuristic -- Figma's API has no dedicated field for this, so it's
 * inferred from naming conventions:
 *
 * 1. It lives on a page/frame whose name contains "icon" (e.g. a page
 *    literally called "Icons") -- containing_frame.pageName, only
 *    available from the fast path's lightweight listing endpoints.
 * 2. Its own name uses "/"-separated hierarchical segments (e.g.
 *    "Outline/Regular/Plus", a common Figma icon-library convention --
 *    confirmed against a real icon set). Figma's own auto-generated
 *    variant-name syntax never uses "/" (it's "Key=Value, Key2=Value2",
 *    see parseVariantName), so this can't misfire on a real variant name.
 *
 * Either signal is enough -- see design-system/icons/page.tsx (the "Icons"
 * tab this drives) and the Components list (which excludes these). If
 * this misclassifies something in a particular Figma file, it shows up
 * immediately as a component sitting in the wrong tab -- easy to spot and
 * report back, versus silently guessing wrong forever.
 */
function isLikelyIconName(name: string, pageLabel: string | undefined): boolean {
  if (pageLabel && /icon/i.test(pageLabel)) return true;
  return name.includes("/");
}

function slugKeyFor(name: string): string {
  return name.trim();
}

/**
 * Figma allows multiple, entirely distinct component sets/standalone
 * components to share the same literal name (e.g. a dozen "Tooltip"
 * entries, one per theme/placement, each never using Figma's own
 * Component Set/Variants feature to tie them together) -- confirmed
 * against a real synced file. Rather than keeping those as separate rows
 * (this used to disambiguate them with a page-name suffix, which just
 * produced more duplicate-looking rows), same-name entries are merged
 * into ONE group here: their variants/states union via a Map keyed by
 * label (so an identical variant/state coming from two merged entries
 * collapses into one, never duplicating), and their figmaNodeIds union via
 * a Set. This is intentionally a literal-name match only -- it won't
 * catch e.g. "Button Primary" / "Button Secondary" (different names, not
 * expressed as Figma variants of one shared component) -- that case needs
 * a person's judgment call, see the Components list's manual "Merge"
 * action for it.
 */
function buildComponentGroups(
  sets: NormalizedComponentSet[],
  standalone: NormalizedStandaloneComponent[],
): ResolvedComponentGroup[] {
  const byName = new Map<string, ResolvedComponentGroup>();
  const order: string[] = [];

  const mergeIn = (
    name: string,
    description: string | undefined,
    figmaNodeIds: string[],
    variants: DesignComponentVariant[],
    states: DesignComponentState[],
    isIcon: boolean,
  ) => {
    const key = slugKeyFor(name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { slug: "", name: key, description, figmaNodeIds: [...figmaNodeIds], variants, states, isIcon });
      order.push(key);
      return;
    }

    const variantMap = new Map(existing.variants.map((v) => [v.name, v]));
    for (const v of variants) if (!variantMap.has(v.name)) variantMap.set(v.name, v);
    const stateMap = new Map(existing.states.map((s) => [s.name, s]));
    for (const s of states) if (!stateMap.has(s.name)) stateMap.set(s.name, s);

    existing.variants = Array.from(variantMap.values());
    existing.states = Array.from(stateMap.values());
    existing.figmaNodeIds = Array.from(new Set([...existing.figmaNodeIds, ...figmaNodeIds]));
    existing.description = existing.description || description;
    existing.isIcon = existing.isIcon || isIcon;
  };

  for (const set of sets) {
    const variantMap = new Map<string, DesignComponentVariant>();
    const stateMap = new Map<string, DesignComponentState>();
    for (const child of set.variantNodes) {
      const pairs = parseVariantName(child.name);
      if (!pairs) {
        variantMap.set(child.name, { name: child.name });
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

    mergeIn(
      set.name,
      set.description,
      [set.nodeId, ...set.variantNodes.map((c) => c.id)],
      Array.from(variantMap.values()),
      Array.from(stateMap.values()),
      isLikelyIconName(set.name, set.pageLabel),
    );
  }

  for (const component of standalone) {
    mergeIn(
      component.name,
      component.description,
      [component.nodeId],
      [],
      [],
      isLikelyIconName(component.name, component.pageLabel),
    );
  }

  const usedSlugs = new Set<string>();
  const uniqueSlug = (base: string) => {
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
    usedSlugs.add(slug);
    return slug;
  };

  return order.map((key) => {
    const group = byName.get(key)!;
    group.slug = uniqueSlug(slugify(group.name));
    return group;
  });
}

// ---- DB upserts (shared by both paths) ----

async function upsertToken(
  workspaceId: string,
  name: string,
  category: DesignTokenCategory,
  value: string,
  description: string | undefined,
  figmaNodeId: string,
): Promise<void> {
  await db
    .insert(designToken)
    .values({ workspaceId, name, category, value, description: description || undefined, figmaNodeId })
    .onConflictDoUpdate({
      target: [designToken.workspaceId, designToken.name],
      set: { category, value, description: description || undefined, figmaNodeId, updatedAt: new Date() },
    });
}

async function upsertComponent(workspaceId: string, group: ResolvedComponentGroup): Promise<void> {
  // Deliberately NOT touching `notes` in the update set -- that field is for
  // hand-written implementation notes (see the component detail page), and
  // a re-sync should never overwrite what a person wrote there.
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
      isIcon: group.isIcon,
    })
    .onConflictDoUpdate({
      target: [designComponent.workspaceId, designComponent.slug],
      set: {
        name: group.name,
        description: group.description,
        variants: group.variants,
        states: group.states,
        figmaNodeIds: group.figmaNodeIds,
        isIcon: group.isIcon,
        updatedAt: new Date(),
      },
    });
}

// ---- Component grouping (shared by full sync, resyncComponentsFromFigma) ----

/**
 * Builds this file's component groups from the fast path's lightweight
 * listing endpoints (already-fetched component/component_set lists) --
 * batches a node fetch for just the component_sets (to read their variant
 * children), splits out standalone components (ones not already claimed
 * as a set's child), and groups via buildComponentGroups. Shared by
 * tryFastSync (full sync) and resyncComponentsFromFigma ("Resync
 * components" below) so the two can't resolve the same file's components
 * differently.
 */
async function fetchComponentGroupsFast(
  fileKey: string,
  accessToken: string,
  components: FigmaPublishedComponent[],
  componentSets: FigmaPublishedComponentSet[],
): Promise<ResolvedComponentGroup[]> {
  const setNodes = await fetchNodesBatched(fileKey, accessToken, componentSets.map((s) => s.node_id));
  const childNodeIdsInSets = new Set<string>();
  const normalizedSets: NormalizedComponentSet[] = componentSets.map((set) => {
    const node = setNodes.get(set.node_id);
    const variantNodes = (node?.children ?? []).map((c) => ({ id: c.id, name: c.name }));
    variantNodes.forEach((c) => childNodeIdsInSets.add(c.id));
    return {
      nodeId: set.node_id,
      name: set.name,
      description: set.description,
      pageLabel: set.containing_frame?.pageName,
      variantNodes,
    };
  });
  const standalone: NormalizedStandaloneComponent[] = components
    .filter((c) => !childNodeIdsInSets.has(c.node_id))
    .map((c) => ({
      nodeId: c.node_id,
      name: c.name,
      description: c.description,
      pageLabel: c.containing_frame?.pageName,
    }));

  return buildComponentGroups(normalizedSets, standalone);
}

/** Same as fetchComponentGroupsFast, but from an already-fetched full-file walk's component/component_set maps. */
function groupComponentsFromFullFile(file: FigmaFileResponse): ResolvedComponentGroup[] {
  const byComponentSetId = new Map<string, [string, FigmaComponent][]>();
  const standaloneEntries: [string, FigmaComponent][] = [];
  for (const entry of Object.entries(file.components)) {
    const [, component] = entry;
    if (component.componentSetId) {
      const list = byComponentSetId.get(component.componentSetId) ?? [];
      list.push(entry);
      byComponentSetId.set(component.componentSetId, list);
    } else {
      standaloneEntries.push(entry);
    }
  }

  const normalizedSets: NormalizedComponentSet[] = Object.entries(file.componentSets).map(([setNodeId, set]) => ({
    nodeId: setNodeId,
    name: set.name,
    description: set.description,
    variantNodes: (byComponentSetId.get(setNodeId) ?? []).map(([nodeId, c]) => ({ id: nodeId, name: c.name })),
  }));
  const standalone: NormalizedStandaloneComponent[] = standaloneEntries.map(([nodeId, c]) => ({
    nodeId,
    name: c.name,
    description: c.description,
  }));

  return buildComponentGroups(normalizedSets, standalone);
}

async function upsertComponentGroups(
  workspaceId: string,
  groups: ResolvedComponentGroup[],
  onProgress: OnSyncProgress,
): Promise<number> {
  let componentsUpserted = 0;
  for (let i = 0; i < groups.length; i++) {
    await upsertComponent(workspaceId, groups[i]);
    componentsUpserted++;
    onProgress({ phase: "components", done: i + 1, total: groups.length });
  }
  return componentsUpserted;
}

// ---- Progress reporting ----

export interface SyncProgressEvent {
  phase: "scope" | "tokens" | "components" | "done" | "error";
  message?: string;
  done?: number;
  total?: number;
  /** Set only on the final "done" event -- lets a caller (the SSE route) hand the
   *  client a structured summary instead of it having to parse `message`. */
  result?: SyncResult;
}

export type OnSyncProgress = (event: SyncProgressEvent) => void;

export interface SyncResult {
  tokensUpserted: number;
  tokensSkipped: number;
  componentsUpserted: number;
}

// ---- Fast path ----

async function tryFastSync(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
  onProgress: OnSyncProgress,
): Promise<SyncResult | null> {
  const key = encodeURIComponent(fileKey);
  const [stylesRes, componentsRes, setsRes] = await Promise.all([
    figmaGet<FigmaFileStylesResponse>(`/files/${key}/styles`, accessToken).catch(() => null),
    figmaGet<FigmaFileComponentsResponse>(`/files/${key}/components`, accessToken).catch(() => null),
    figmaGet<FigmaFileComponentSetsResponse>(`/files/${key}/component_sets`, accessToken).catch(() => null),
  ]);

  const styles = stylesRes?.meta.styles ?? [];
  const components = componentsRes?.meta.components ?? [];
  const componentSets = setsRes?.meta.component_sets ?? [];

  if (styles.length === 0 && components.length === 0 && componentSets.length === 0) {
    // Signals "this file doesn't look like a published library" to the caller, not an error --
    // the caller falls back to the full-file walk.
    return null;
  }

  onProgress({
    phase: "scope",
    message: `Found ${styles.length} style(s), ${componentSets.length} component set(s), ${components.length} component(s) (published library -- fast path).`,
  });

  // ---- Tokens ----
  const styleNodes = await fetchNodesBatched(fileKey, accessToken, styles.map((s) => s.node_id));
  let tokensUpserted = 0;
  let tokensSkipped = 0;
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const category = STYLE_TYPE_TO_CATEGORY[style.style_type];
    const node = styleNodes.get(style.node_id);
    const value = category && node ? resolveStyleValue(category, node) : undefined;
    if (category && value) {
      await upsertToken(workspaceId, style.name, category, value, style.description, style.node_id);
      tokensUpserted++;
    } else {
      tokensSkipped++;
    }
    onProgress({ phase: "tokens", done: i + 1, total: styles.length });
  }

  // ---- Components ----
  const groups = await fetchComponentGroupsFast(fileKey, accessToken, components, componentSets);
  const componentsUpserted = await upsertComponentGroups(workspaceId, groups, onProgress);

  return { tokensUpserted, tokensSkipped, componentsUpserted };
}

// ---- Fallback path: full file walk ----

async function syncViaFullFileWalk(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
  onProgress: OnSyncProgress,
): Promise<SyncResult> {
  const file = await figmaGet<FigmaFileResponse>(
    `/files/${encodeURIComponent(fileKey)}`,
    accessToken,
    FIGMA_FILE_FETCH_TIMEOUT_MS,
  );

  const resolvedStyles = resolveStylesFromDocumentTree(file.document, file.styles);
  const styleEntries = Array.from(resolvedStyles.entries());
  onProgress({
    phase: "scope",
    message: `This file isn't set up as a published Figma library, so this needed a full scan: ${styleEntries.length} resolvable style(s), ${Object.keys(file.componentSets).length} component set(s), ${Object.keys(file.components).length} component(s).`,
  });

  let tokensUpserted = 0;
  for (let i = 0; i < styleEntries.length; i++) {
    const [styleId, resolved] = styleEntries[i];
    const meta = file.styles[styleId];
    await upsertToken(workspaceId, meta.name, resolved.category, resolved.value, meta.description, resolved.figmaNodeId);
    tokensUpserted++;
    onProgress({ phase: "tokens", done: i + 1, total: styleEntries.length });
  }
  const tokensSkipped = Object.keys(file.styles).length - resolvedStyles.size;

  const groups = groupComponentsFromFullFile(file);
  const componentsUpserted = await upsertComponentGroups(workspaceId, groups, onProgress);

  return { tokensUpserted, tokensSkipped, componentsUpserted };
}

// ---- Entry point ----

export async function syncDesignSystemFromFigma(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
  onProgress: OnSyncProgress = () => {},
): Promise<SyncResult> {
  const fast = await tryFastSync(workspaceId, fileKey, accessToken, onProgress);
  if (fast) return fast;
  return syncViaFullFileWalk(workspaceId, fileKey, accessToken, onProgress);
}

// ---- Targeted resync: single component ----

export interface ComponentResyncResult {
  name: string;
  /** Human-readable summary of what changed, for a status line -- e.g.
   *  "1 added (Size: Large); 1 removed (State: Disabled)." or "No
   *  variant/state changes." */
  summary: string;
}

/**
 * Re-fetches ONE component's Figma node (figmaNodeIds[0] -- the
 * component-set node for a set, or the component node itself if
 * standalone) and diffs its CURRENT children against what's stored,
 * rather than blindly re-fetching the same child IDs -- this is what
 * catches a variant added/removed in Figma since the last sync, not just
 * a changed value on an existing one. Reuses the exact same variant/state
 * parsing this file's full sync already does (parseVariantName), so the
 * two paths can't silently drift apart on what counts as a "state" vs a
 * "variant".
 *
 * Updates the DB row in place. Unlike a full sync's buildComponentGroups,
 * this deliberately does NOT re-slugify from the (possibly renamed) Figma
 * name -- `slug` is this row's identity anchor (URL, code-sync tracking),
 * so it's left untouched here; only name/variants/states/figmaNodeIds
 * change. `notes` and the code-sync tracking columns (codeSyncStatus etc)
 * are untouched too, same "never clobber" rule as upsertComponent above.
 *
 * Used by the component detail page's "Resync this component" action
 * (design-system/components/[slug]/actions.ts). See also
 * resyncTokensFromFigma below for "Resync tokens".
 */
export async function resyncComponentFromFigma(
  fileKey: string,
  accessToken: string,
  component: {
    id: string;
    name: string;
    figmaNodeIds: string[];
    variants: DesignComponentVariant[];
    states: DesignComponentState[];
  },
): Promise<ComponentResyncResult> {
  const primaryNodeId = component.figmaNodeIds[0];
  if (!primaryNodeId) {
    throw new Error(`"${component.name}" has no stored Figma node ID to resync from -- run a full sync first.`);
  }

  const nodes = await fetchNodesBatched(fileKey, accessToken, [primaryNodeId]);
  const node = nodes.get(primaryNodeId);
  if (!node) {
    throw new Error(
      `Figma node ${primaryNodeId} for "${component.name}" no longer exists -- it may have been deleted or moved in Figma.`,
    );
  }

  const isSet = node.type === "COMPONENT_SET" && (node.children?.length ?? 0) > 0;
  const children = isSet ? (node.children ?? []).map((c) => ({ id: c.id, name: c.name })) : [];

  const variantMap = new Map<string, DesignComponentVariant>();
  const stateMap = new Map<string, DesignComponentState>();
  for (const child of children) {
    const pairs = parseVariantName(child.name);
    if (!pairs) {
      variantMap.set(child.name, { name: child.name });
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

  const newVariants = Array.from(variantMap.values());
  const newStates = Array.from(stateMap.values());
  const newFigmaNodeIds = isSet ? [node.id, ...children.map((c) => c.id)] : [node.id];

  const oldLabels = new Set([...component.variants.map((v) => v.name), ...component.states.map((s) => s.name)]);
  const newLabels = new Set([...newVariants.map((v) => v.name), ...newStates.map((s) => s.name)]);
  const added = Array.from(newLabels).filter((l) => !oldLabels.has(l));
  const removed = Array.from(oldLabels).filter((l) => !newLabels.has(l));

  await db
    .update(designComponent)
    .set({
      name: node.name,
      variants: newVariants,
      states: newStates,
      figmaNodeIds: newFigmaNodeIds,
      // No pageLabel available from a raw node fetch (only the fast
      // path's lightweight listing endpoints carry containing_frame) --
      // name-only re-check, see isLikelyIconName's doc comment.
      isIcon: isLikelyIconName(node.name, undefined),
      updatedAt: new Date(),
    })
    .where(eq(designComponent.id, component.id));

  const summary =
    added.length === 0 && removed.length === 0
      ? "No variant/state changes."
      : [
          added.length > 0 ? `${added.length} added (${added.join(", ")})` : null,
          removed.length > 0 ? `${removed.length} removed (${removed.join(", ")})` : null,
        ]
          .filter(Boolean)
          .join("; ") + ".";

  return { name: node.name, summary };
}

// ---- Targeted resync: tokens only ----

export interface TokensResyncResult {
  tokensUpserted: number;
  tokensSkipped: number;
}

/**
 * Re-fetches just the Figma styles listing (or, for files that aren't
 * published libraries, walks the full file for styles only) and upserts
 * them -- "Resync tokens" on the Settings page, for when only colors/type/
 * spacing changed and a full sync (which also re-lists every component)
 * isn't needed. Shares tryFastSync's/syncViaFullFileWalk's exact style
 * resolution logic so this can't drift from what a full sync would
 * resolve the same tokens to.
 */
export async function resyncTokensFromFigma(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
): Promise<TokensResyncResult> {
  const key = encodeURIComponent(fileKey);
  const stylesRes = await figmaGet<FigmaFileStylesResponse>(`/files/${key}/styles`, accessToken).catch(() => null);
  const styles = stylesRes?.meta.styles ?? [];

  if (styles.length > 0) {
    const styleNodes = await fetchNodesBatched(fileKey, accessToken, styles.map((s) => s.node_id));
    let tokensUpserted = 0;
    let tokensSkipped = 0;
    for (const style of styles) {
      const category = STYLE_TYPE_TO_CATEGORY[style.style_type];
      const node = styleNodes.get(style.node_id);
      const value = category && node ? resolveStyleValue(category, node) : undefined;
      if (category && value) {
        await upsertToken(workspaceId, style.name, category, value, style.description, style.node_id);
        tokensUpserted++;
      } else {
        tokensSkipped++;
      }
    }
    return { tokensUpserted, tokensSkipped };
  }

  // Not a published library -- fall back to a full-file walk for styles only
  // (mirrors syncViaFullFileWalk's tokens phase, without touching components).
  const file = await figmaGet<FigmaFileResponse>(`/files/${key}`, accessToken, FIGMA_FILE_FETCH_TIMEOUT_MS);
  const resolvedStyles = resolveStylesFromDocumentTree(file.document, file.styles);
  for (const [styleId, resolved] of resolvedStyles.entries()) {
    const meta = file.styles[styleId];
    await upsertToken(workspaceId, meta.name, resolved.category, resolved.value, meta.description, resolved.figmaNodeId);
  }
  const tokensSkipped = Object.keys(file.styles).length - resolvedStyles.size;
  return { tokensUpserted: resolvedStyles.size, tokensSkipped };
}

// ---- Targeted resync: components only ----

export interface ComponentsResyncResult {
  componentsUpserted: number;
}

/**
 * Re-lists and upserts every component (fast path's component/component_set
 * listing, or a full-file walk for components only as fallback) WITHOUT
 * touching tokens/styles at all -- "Resync components" on the Settings
 * page, symmetric with resyncTokensFromFigma above, for when only
 * components changed (renamed, variants added/removed) and a full sync
 * (which also re-lists every style) isn't needed. Shares
 * fetchComponentGroupsFast/groupComponentsFromFullFile with the full sync
 * so this can't resolve the same file's components differently.
 *
 * Metadata only, deliberately: unlike resyncTokens (which also cheaply
 * regenerates the deterministic tokens.css on every call), this does NOT
 * trigger code generation for anything -- regenerating a component's code
 * is an LLM call, not something to fire automatically for every component
 * on every metadata resync. Use "Generate code" or a component's own
 * "Resync this component" for that.
 */
export async function resyncComponentsFromFigma(
  workspaceId: string,
  fileKey: string,
  accessToken: string,
  onProgress: OnSyncProgress = () => {},
): Promise<ComponentsResyncResult> {
  const key = encodeURIComponent(fileKey);
  const [componentsRes, setsRes] = await Promise.all([
    figmaGet<FigmaFileComponentsResponse>(`/files/${key}/components`, accessToken).catch(() => null),
    figmaGet<FigmaFileComponentSetsResponse>(`/files/${key}/component_sets`, accessToken).catch(() => null),
  ]);
  const components = componentsRes?.meta.components ?? [];
  const componentSets = setsRes?.meta.component_sets ?? [];

  if (components.length === 0 && componentSets.length === 0) {
    // Not a published library (or genuinely has zero components) --
    // mirrors syncViaFullFileWalk's components phase, without touching tokens.
    const file = await figmaGet<FigmaFileResponse>(`/files/${key}`, accessToken, FIGMA_FILE_FETCH_TIMEOUT_MS);
    onProgress({
      phase: "scope",
      message: `This file isn't set up as a published Figma library, so this needed a full scan: ${Object.keys(file.componentSets).length} component set(s), ${Object.keys(file.components).length} component(s).`,
    });
    const groups = groupComponentsFromFullFile(file);
    const componentsUpserted = await upsertComponentGroups(workspaceId, groups, onProgress);
    return { componentsUpserted };
  }

  onProgress({
    phase: "scope",
    message: `Found ${componentSets.length} component set(s), ${components.length} component(s) (published library -- fast path).`,
  });
  const groups = await fetchComponentGroupsFast(fileKey, accessToken, components, componentSets);
  const componentsUpserted = await upsertComponentGroups(workspaceId, groups, onProgress);
  return { componentsUpserted };
}
