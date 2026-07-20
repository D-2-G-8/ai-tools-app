import "server-only";
import { put, del } from "@/lib/storage";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { mockup, designComponent, workspace } from "@/db/schema";
import { figmaGet, getFileImages, getFileNodes, getValidFigmaAccessToken } from "@/lib/figma/client";
import { fetchScreenDesign, type ComponentIndex, type FigmaNode, type FigmaNodesResponse } from "./figma-node";
import { loadTokensForCss } from "./data";
import { buildComponentIndex } from "./dependencies";

/**
 * Imports existing app SCREENS from Figma as reference ("historical") mockups:
 * a screenshot + a distilled structure spec + the design-system components each
 * screen uses. These ground AI mockup generation on the real product, and are
 * re-imported by the "Sync mockups from Figma" button (designers keep doing the
 * complex parts in Figma). Mirrors the component sync (src/lib/figma/sync.ts):
 * fetch -> upsert -> reconcile, authoritative over source="figma" rows.
 */

export interface ScreenFrame {
  nodeId: string;
  name: string;
}

/**
 * Extracts a Figma node id from a URL or a raw id. Figma URLs carry it as
 * `?node-id=1-2` (hyphen); the API uses `1:2` (colon).
 */
export function parseFigmaNodeId(urlOrId: string): string | null {
  const s = urlOrId.trim();
  if (!s) return null;
  const fromUrl = s.match(/node-id=([0-9]+-[0-9]+)/);
  if (fromUrl) return fromUrl[1].replace("-", ":");
  const raw = s.match(/^([0-9]+)[:-]([0-9]+)$/);
  if (raw) return `${raw[1]}:${raw[2]}`;
  return null;
}

// Pages that hold library primitives, not app screens -- skipped by auto
// discovery. Matched case-insensitively as whole words.
const NON_SCREEN_PAGE = /\b(icons?|tokens?|styles?|base elements?|components?|cover|changelog)\b/i;

interface FigmaFileShallow {
  document: FigmaNode;
}

/**
 * Auto-discovers candidate screen frames: the top-level FRAME children of every
 * page (CANVAS) that isn't a library/service page. `depth=2` returns pages plus
 * their direct children in one call.
 */
export async function discoverScreenFrames(fileKey: string, accessToken: string): Promise<ScreenFrame[]> {
  const res = await figmaGet<FigmaFileShallow>(`/files/${fileKey}?depth=2`, accessToken, 55_000);
  const frames: ScreenFrame[] = [];
  for (const page of res.document.children ?? []) {
    if (page.type !== "CANVAS" || NON_SCREEN_PAGE.test(page.name)) continue;
    for (const child of page.children ?? []) {
      if (child.type === "FRAME") frames.push({ nodeId: child.id, name: child.name });
    }
  }
  return frames;
}

/** Fetches a node's display name (for manual-URL frames without a known name). */
async function frameName(fileKey: string, nodeId: string, accessToken: string): Promise<string> {
  const res = await getFileNodes<FigmaNodesResponse>(fileKey, [nodeId], accessToken);
  return res.nodes[nodeId]?.document?.name ?? nodeId;
}

async function uploadScreenshot(pngUrl: string, nodeId: string): Promise<string> {
  const res = await fetch(pngUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't fetch Figma screenshot (${res.status})`);
  const safeId = nodeId.replace(":", "-");
  // The storage abstraction accepts string | File, so wrap the PNG bytes in a File.
  const file = new File([new Uint8Array(await res.arrayBuffer())], `${safeId}.png`, { type: "image/png" });
  const blob = await put(`mockups/figma/${safeId}.png`, file, {
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

/**
 * Imports the given screen frames as source="figma" reference mockups and
 * reconciles: figma mockups no longer in the set are deleted (their screenshots
 * cleaned from Blob). Guarded on a non-empty imported set so a transient empty
 * discovery can't wipe existing references.
 */
export async function syncMockupsFromFigma(workspaceId: string, frames: ScreenFrame[]): Promise<SyncMockupsResult> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const token = await getValidFigmaAccessToken();
  if (!ws?.figmaFileKey || !token) throw new Error("Figma isn't connected for this workspace.");
  const fileKey = ws.figmaFileKey;

  const tokens = await loadTokensForCss(workspaceId);
  const allComponents = await db
    .select({ slug: designComponent.slug, figmaNodeIds: designComponent.figmaNodeIds, isIcon: designComponent.isIcon })
    .from(designComponent)
    .where(eq(designComponent.workspaceId, workspaceId));
  const index: ComponentIndex = buildComponentIndex(allComponents);

  const errors: { name: string; error: string }[] = [];
  const keptNodeIds: string[] = [];
  let imported = 0;

  for (const frame of frames) {
    try {
      const [pngMap, design, name] = await Promise.all([
        getFileImages(fileKey, [frame.nodeId], token, { format: "png", scale: 2 }),
        fetchScreenDesign(fileKey, frame.nodeId, token, tokens, index),
        frame.name ? Promise.resolve(frame.name) : frameName(fileKey, frame.nodeId, token),
      ]);
      const pngUrl = pngMap[frame.nodeId];
      if (!pngUrl) throw new Error("Figma returned no screenshot for this frame.");
      const previewBlobUrl = await uploadScreenshot(pngUrl, frame.nodeId);

      const values = {
        workspaceId,
        name,
        filename: `${name}.figma`,
        source: "figma" as const,
        figmaFileKey: fileKey,
        figmaNodeId: frame.nodeId,
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
      keptNodeIds.push(frame.nodeId);
      imported++;
    } catch (err) {
      errors.push({ name: frame.name || frame.nodeId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let removed = 0;
  if (keptNodeIds.length > 0) {
    const existing = await db
      .select({ id: mockup.id, figmaNodeId: mockup.figmaNodeId, previewBlobUrl: mockup.previewBlobUrl })
      .from(mockup)
      .where(and(eq(mockup.workspaceId, workspaceId), eq(mockup.source, "figma")));
    const stale = existing.filter((m) => m.figmaNodeId && !keptNodeIds.includes(m.figmaNodeId));
    if (stale.length > 0) {
      for (const m of stale) if (m.previewBlobUrl) await del(m.previewBlobUrl).catch(() => {});
      await db.delete(mockup).where(
        inArray(
          mockup.id,
          stale.map((m) => m.id),
        ),
      );
      removed = stale.length;
    }
  }

  return { imported, removed, errors };
}
