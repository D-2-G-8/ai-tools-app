import "server-only";
import { getFileNodes } from "@/lib/figma/client";
import { componentIdentifier } from "./component";
import type { ComponentIndex, ComponentRef, FigmaNode, FigmaNodesResponse } from "./figma-node";

/**
 * Component-composition dependency graph for the design-system codegen.
 *
 * A component A "depends on" B when A's Figma subtree places an INSTANCE of B
 * (an INSTANCE node whose componentId belongs to B -- see ComponentIndex).
 * The generated A imports and renders B instead of re-implementing it, so B's
 * code must exist first. This module builds that graph and topologically
 * orders the components so every dependency is generated before its dependents.
 */

interface ComponentRow {
  slug: string;
  figmaNodeIds: string[];
  isIcon: boolean;
}

/**
 * figmaNodeId -> the design_component that node belongs to, for EVERY node id
 * a component owns (a component set root, each variant, sub-parts). Lets an
 * INSTANCE's componentId resolve to "this is component B" no matter which of
 * B's nodes it was instanced from.
 */
export function buildComponentIndex(rows: ComponentRow[]): ComponentIndex {
  const index: ComponentIndex = new Map();
  for (const row of rows) {
    const ref: ComponentRef = { slug: row.slug, componentName: componentIdentifier(row.slug), isIcon: row.isIcon };
    for (const nodeId of row.figmaNodeIds) {
      // First writer wins -- a node id belongs to exactly one component; if two
      // rows somehow claim it, prefer the earlier (stable) one.
      if (!index.has(nodeId)) index.set(nodeId, ref);
    }
  }
  return index;
}

/** Every design-system component B that this node's subtree instances (by slug). */
function collectUses(node: FigmaNode, index: ComponentIndex, selfSlug: string, out: Set<string>): void {
  if (node.type === "INSTANCE" && node.componentId) {
    const ref = index.get(node.componentId);
    if (ref && ref.slug !== selfSlug) {
      out.add(ref.slug);
      return; // don't descend into an instance -- its internals belong to B, not A
    }
  }
  for (const child of node.children ?? []) collectUses(child, index, selfSlug, out);
}

// Figma's /nodes endpoint takes many ids at once; batch so building the graph
// for a whole library is a handful of requests, not one per component.
const NODES_BATCH = 40;

/**
 * dependency edges: slug -> the slugs it directly composes. Fetches each
 * component's root subtree (batched) and scans for INSTANCE references.
 * Components with no figma node id are skipped (nothing to scan).
 */
export async function buildDependencyEdges(
  components: ComponentRow[],
  fileKey: string,
  accessToken: string,
  index: ComponentIndex,
): Promise<Map<string, string[]>> {
  const edges = new Map<string, string[]>();
  const roots: { slug: string; nodeId: string }[] = [];
  for (const c of components) {
    edges.set(c.slug, []); // ensure every component is a graph node, even leaves
    if (c.figmaNodeIds[0]) roots.push({ slug: c.slug, nodeId: c.figmaNodeIds[0] });
  }

  for (let i = 0; i < roots.length; i += NODES_BATCH) {
    const batch = roots.slice(i, i + NODES_BATCH);
    const res = await getFileNodes<FigmaNodesResponse>(
      fileKey,
      batch.map((r) => r.nodeId),
      accessToken,
    );
    for (const r of batch) {
      const doc = res.nodes[r.nodeId]?.document;
      if (!doc) continue;
      const out = new Set<string>();
      collectUses(doc, index, r.slug, out);
      edges.set(r.slug, [...out]);
    }
  }
  return edges;
}

/**
 * The dependency CLOSURE of one component: the component itself plus every
 * component it transitively composes. Discovered breadth-first -- fetch the
 * root's instances, then their instances, and so on -- so "Generate Avatar"
 * pulls in IconButton, BadgeCount, the profile icon, and anything THOSE
 * compose, and nothing unrelated. Returns the closure slugs and the edges
 * among them (ready for topoLevels).
 */
export async function dependencyClosure(
  rootSlug: string,
  components: ComponentRow[],
  fileKey: string,
  accessToken: string,
  index: ComponentIndex,
): Promise<{ slugs: string[]; edges: Map<string, string[]> }> {
  const bySlug = new Map(components.map((c) => [c.slug, c]));
  const known = new Set<string>([rootSlug]);
  const edges = new Map<string, string[]>();
  let frontier = [rootSlug];

  while (frontier.length > 0) {
    const rows = frontier.map((s) => bySlug.get(s)).filter((c): c is ComponentRow => Boolean(c));
    const batch = await buildDependencyEdges(rows, fileKey, accessToken, index);
    const next: string[] = [];
    for (const [slug, deps] of batch) {
      edges.set(slug, deps);
      for (const dep of deps) {
        if (!known.has(dep)) {
          known.add(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  // ensure every closure member is a graph node even if it had no edges yet
  for (const s of known) if (!edges.has(s)) edges.set(s, []);
  return { slugs: [...known], edges };
}

/**
 * Kahn's algorithm: returns slugs so that every dependency comes before the
 * components that use it. Edges to slugs outside `slugs` (e.g. a dependency
 * not in this run) are ignored. Cycles (rare for UI, e.g. A instances B and B
 * instances A) can't be fully ordered -- the leftover nodes are appended in
 * their input order and reported in `cycleBroken` so the caller can log that
 * one edge of each cycle will fall back to inlining rather than importing.
 */
export function topoSort(
  slugs: string[],
  edges: Map<string, string[]>,
): { ordered: string[]; cycleBroken: string[] } {
  const inSet = new Set(slugs);
  // outstanding deps for each slug, restricted to slugs in this run
  const remaining = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>(); // dep -> [slugs that need it]
  for (const s of slugs) {
    const deps = (edges.get(s) ?? []).filter((d) => inSet.has(d) && d !== s);
    remaining.set(s, new Set(deps));
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), s]);
  }

  const ordered: string[] = [];
  // seed with dependency-free components, preserving input order for stability
  const ready = slugs.filter((s) => remaining.get(s)!.size === 0);
  while (ready.length > 0) {
    const s = ready.shift()!;
    ordered.push(s);
    for (const dep of dependents.get(s) ?? []) {
      const rem = remaining.get(dep)!;
      rem.delete(s);
      if (rem.size === 0 && !ordered.includes(dep) && !ready.includes(dep)) ready.push(dep);
    }
  }

  const cycleBroken = slugs.filter((s) => !ordered.includes(s));
  return { ordered: [...ordered, ...cycleBroken], cycleBroken };
}

/**
 * Groups the components into dependency LEVELS: level 0 = components with no
 * (in-run) dependencies, level N = components whose deepest dependency is at
 * level N-1. The codegen orchestrator generates one level fully (in parallel,
 * safely) before starting the next, so every component's dependencies are
 * already committed when it runs -- unlike a flat parallel sweep, where a
 * dependent could start before its dependency commits and lose the composition.
 * Cycle members (topoSort.cycleBroken) are placed in a final level.
 */
export function topoLevels(slugs: string[], edges: Map<string, string[]>): string[][] {
  const inSet = new Set(slugs);
  const { ordered, cycleBroken } = topoSort(slugs, edges);
  const cyclic = new Set(cycleBroken);
  const level = new Map<string, number>();

  for (const s of ordered) {
    if (cyclic.has(s)) continue;
    const deps = (edges.get(s) ?? []).filter((d) => inSet.has(d) && d !== s && !cyclic.has(d));
    const lvl = deps.reduce((max, d) => Math.max(max, (level.get(d) ?? 0) + 1), 0);
    level.set(s, lvl);
  }

  const maxLevel = level.size ? Math.max(...level.values()) : -1;
  const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const [s, lvl] of level) levels[lvl].push(s);
  if (cycleBroken.length) levels.push(cycleBroken); // cyclic remainder last
  return levels.filter((l) => l.length > 0);
}
