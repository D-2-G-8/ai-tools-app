import "server-only";
import { put, del } from "@/lib/storage";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { mockup, designComponent } from "@/db/schema";
import { figmaGet, getFileImages, getValidFigmaAccessToken } from "@/lib/figma/client";
import { fetchScreenDesign, type ComponentIndex, type FigmaNode, type FigmaNodesResponse } from "./figma-node";
import { loadTokensForCss } from "./data";
import { buildComponentIndex } from "./dependencies";

/**
 * Imports existing app SCREENS from Figma as reference ("historical") mockups
 * to ground AI mockup generation. Reality of the source files (see the pasted
 * examples): screens live in per-feature Figma files (NOT the design-system
 * file), and a pasted URL points at a huge nested-SECTION flow board, not a
 * single screen. So this: (1) reads the file key + node id from each URL,
 * (2) recursively extracts the individual screen FRAMES from the board, and
 * (3) imports each screen as its own reference mockup (screenshot + distilled
 * structure + design-system components it uses). Re-syncable by button.
 *
 * Cross-file caveat: a design-system component instanced in a product file
 * references the library component by a global key, not the DS file's node id,
 * so component detection (usesComponents) is sparse cross-file for now -- the
 * screenshot + structure still ground generation. (Key-based mapping is a
 * follow-up.)
 */

export interface FigmaRef {
  fileKey: string;
  nodeId: string;
}

export interface ScreenFrame {
  nodeId: string;
  name: string;
}

/** Parses a Figma URL (or "fileKey#nodeId") into its file key and node id. */
export function parseFigmaRef(url: string): FigmaRef | null {
  const s = url.trim();
  if (!s) return null;
  const file = s.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/);
  const node = s.match(/node-id=([0-9]+-[0-9]+)/) ?? s.match(/node-id=([0-9]+:[0-9]+)/);
  if (!file || !node) return null;
  return { fileKey: file[1], nodeId: node[1].replace("-", ":") };
}

// A "screen" is a FRAME whose size sits within real device bounds. Bigger
// FRAMEs / SECTIONs are flow-board containers we descend through; smaller ones
// are UI parts, not screens.
const MIN_W = 240;
const MAX_W = 2560;
const MIN_H = 320;
const MAX_H = 6000;
const MAX_SCREENS_PER_ROOT = 300;

function isScreenFrame(node: FigmaNode): boolean {
  if (node.type !== "FRAME") return false;
  const b = node.absoluteBoundingBox;
  if (!b) return false;
  return b.width >= MIN_W && b.width <= MAX_W && b.height >= MIN_H && b.height <= MAX_H;
}

function isContainer(node: FigmaNode): boolean {
  // A board/grouping to descend into for screens -- NOT a screen itself.
  if (node.type === "SECTION" || node.type === "GROUP" || node.type === "CANVAS") return true;
  return node.type === "FRAME" && !isScreenFrame(node); // an over-sized FRAME is a flow container
}

/**
 * Pulls the individual screen frames out of a flow board WITHOUT ever fetching
 * a screen's internals. Breadth-first with `depth=1` fetches (batched per
 * level): each call returns a set of containers plus their DIRECT children, so
 * we classify children (screen -> collect and stop; container -> descend) and
 * never pull the thousands of nodes inside each screen. This keeps payloads
 * tiny -- the naive "fetch the whole board" was ~92MB for one board.
 */
async function extractScreenFrames(fileKey: string, rootNodeId: string, accessToken: string): Promise<ScreenFrame[]> {
  const screens: ScreenFrame[] = [];
  const seen = new Set<string>();
  let frontier = [rootNodeId];

  for (let level = 0; level < 12 && frontier.length > 0 && screens.length < MAX_SCREENS_PER_ROOT; level++) {
    const ids = frontier.slice(0, 100); // Figma caps ids per call; a board rarely has >100 containers per level
    const res = await figmaGet<FigmaNodesResponse>(
      `/files/${fileKey}/nodes?ids=${ids.map(encodeURIComponent).join(",")}&depth=1`,
      accessToken,
      55_000,
    );
    const next: string[] = [];
    for (const id of ids) {
      const doc = res.nodes[id]?.document;
      if (!doc) continue;
      // The pasted node could itself be a screen (a direct-frame link).
      if (isScreenFrame(doc)) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          screens.push({ nodeId: doc.id, name: doc.name });
        }
        continue;
      }
      for (const child of doc.children ?? []) {
        if (isScreenFrame(child)) {
          if (!seen.has(child.id) && screens.length < MAX_SCREENS_PER_ROOT) {
            seen.add(child.id);
            screens.push({ nodeId: child.id, name: child.name });
          }
        } else if (isContainer(child)) {
          next.push(child.id);
        }
      }
    }
    frontier = next;
  }
  return screens;
}

async function uploadScreenshot(pngUrl: string, fileKey: string, nodeId: string): Promise<string> {
  const res = await fetch(pngUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't fetch Figma screenshot (${res.status})`);
  const safe = `${fileKey}-${nodeId.replace(":", "-")}`;
  const file = new File([new Uint8Array(await res.arrayBuffer())], `${safe}.png`, { type: "image/png" });
  const blob = await put(`mockups/figma/${safe}.png`, file, {
    access: "public",
    contentType: "image/png",
    addRandomSuffix: true,
  });
  return blob.url;
}

export interface SyncMockupsResult {
  imported: number;
  removed: number;
  errors: { name: string; error: string }[];
}

const IMAGE_BATCH = 40;

/**
 * Imports the screens found under each pasted Figma ref (file + board/frame) as
 * source="figma" reference mockups, then reconciles PER FILE touched this run
 * (screens removed from a re-synced file are deleted; other files untouched),
 * so incremental board-by-board imports don't wipe each other.
 */
export async function syncMockupsFromFigma(workspaceId: string, refs: FigmaRef[]): Promise<SyncMockupsResult> {
  const token = await getValidFigmaAccessToken();
  if (!token) throw new Error("Figma isn't connected (no access token).");

  const tokens = await loadTokensForCss(workspaceId);
  const allComponents = await db
    .select({ slug: designComponent.slug, figmaNodeIds: designComponent.figmaNodeIds, isIcon: designComponent.isIcon })
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId));
  const index: ComponentIndex = buildComponentIndex(allComponents);

  const errors: { name: string; error: string }[] = [];
  const importedByFile = new Map<string, Set<string>>();
  let imported = 0;

  for (const ref of refs) {
    let screens: ScreenFrame[];
    try {
      screens = await extractScreenFrames(ref.fileKey, ref.nodeId, token);
    } catch (err) {
      errors.push({ name: ref.nodeId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (screens.length === 0) {
      errors.push({ name: ref.nodeId, error: "No screen-sized frames found under this node." });
      continue;
    }

    const keptForFile = importedByFile.get(ref.fileKey) ?? new Set<string>();
    importedByFile.set(ref.fileKey, keptForFile);

    // Render all this board's screens in as few image calls as possible.
    const pngMap: Record<string, string | null> = {};
    for (let i = 0; i < screens.length; i += IMAGE_BATCH) {
      const batch = screens.slice(i, i + IMAGE_BATCH).map((s) => s.nodeId);
      Object.assign(pngMap, await getFileImages(ref.fileKey, batch, token, { format: "png", scale: 2 }));
    }

    const importOne = async (screen: ScreenFrame) => {
      try {
        const pngUrl = pngMap[screen.nodeId];
        if (!pngUrl) throw new Error("Figma returned no screenshot for this frame.");
        const [previewBlobUrl, design] = await Promise.all([
          uploadScreenshot(pngUrl, ref.fileKey, screen.nodeId),
          fetchScreenDesign(ref.fileKey, screen.nodeId, token, tokens, index),
        ]);

        const values = {
          workspaceId,
          name: screen.name,
          filename: `${screen.name}.figma`,
          source: "figma" as const,
          figmaFileKey: ref.fileKey,
          figmaNodeId: screen.nodeId,
          previewBlobUrl,
          structureText: design?.spec ?? null,
          usesComponents: design?.uses.map((u) => u.slug) ?? [],
          lastSyncedAt: new Date(),
          status: "ready" as const,
          errorMessage: null,
          updatedAt: new Date(),
        };
        await db
          .insert(mockup)
          .values(values)
          .onConflictDoUpdate({ target: [mockup.workspaceId, mockup.figmaNodeId], set: values });
        keptForFile.add(screen.nodeId);
        imported++;
      } catch (err) {
        errors.push({ name: screen.name, error: err instanceof Error ? err.message : String(err) });
      }
    };

    // Bounded concurrency: screenshot upload + structure distillation per screen
    // is I/O-bound, so a few in flight keeps a large board within the request
    // budget without hammering Figma.
    const CONCURRENCY = 6;
    for (let i = 0; i < screens.length; i += CONCURRENCY) {
      await Promise.all(screens.slice(i, i + CONCURRENCY).map(importOne));
    }
  }

  // Reconcile within each touched file only (never across files), and only if
  // that file imported at least one screen (so a fully-failed board can't wipe
  // its previously-imported screens).
  let removed = 0;
  for (const [fileKey, kept] of importedByFile) {
    if (kept.size === 0) continue;
    const existing = await db
      .select({ id: mockup.id, figmaNodeId: mockup.figmaNodeId, previewBlobUrl: mockup.previewBlobUrl })
      .from(mockup)
      .where(and(eq(mockup.workspaceId, workspaceId), eq(mockup.source, "figma"), eq(mockup.figmaFileKey, fileKey)));
    const stale = existing.filter((m) => m.figmaNodeId && !kept.has(m.figmaNodeId));
    if (stale.length > 0) {
      for (const m of stale) if (m.previewBlobUrl) await del(m.previewBlobUrl).catch(() => {});
      await db.delete(mockup).where(
        inArray(
          mockup.id,
          stale.map((m) => m.id),
        ),
      );
      removed += stale.length;
    }
  }

  return { imported, removed, errors };
}
