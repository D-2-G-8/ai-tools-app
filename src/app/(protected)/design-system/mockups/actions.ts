"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { put, del } from "@/lib/storage";
import { db } from "@/db";
import { mockup } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { and } from "drizzle-orm";
import { designComponent } from "@/db/schema";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { commitFiles } from "@/lib/github/client";
import { getOrOpenSessionBranch } from "@/lib/design-system-codegen/session";
import { finishCodeGenSession } from "@/lib/design-system-codegen/session-actions";
import {
  parseFigmaRef,
  syncMockupsFromFigma,
  type FigmaRef,
  type SyncMockupsResult,
} from "@/lib/design-system-codegen/mockup-sync";
import {
  buildComponentCatalog,
  generateScreenStory,
  type CatalogComponent,
} from "@/lib/design-system-codegen/screen-story";

/**
 * Mockups are self-contained .html files (design-system tokens/components
 * inlined, no external asset references — see the "Mockups" tab README
 * note) stored in Blob, same access model as documents. Unlike documents
 * there is no ingest/chunking pipeline — a mockup is just stored and served.
 *
 * Mirrors app/documents/actions.ts: per-file try/catch so one bad upload in
 * a multi-file batch can't fail the rest or crash the page.
 */
export async function uploadMockup(formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();
  const files = formData.getAll("file").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    throw new Error("No files found in the form");
  }

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".html")) {
      continue;
    }

    try {
      const blob = await put(`mockups/${Date.now()}-${file.name}`, file, {
        access: "public",
        addRandomSuffix: true,
      });

      await db.insert(mockup).values({
        workspaceId,
        name: file.name.replace(/\.html$/i, ""),
        filename: file.name,
        blobUrl: blob.url,
        status: "ready",
      });
    } catch (err) {
      console.error(`Failed to upload "${file.name}":`, err);
    }
  }

  revalidatePath("/design-system/mockups");
}

/**
 * Imports existing app screens from Figma as reference mockups. Takes Figma
 * URLs (one per line) pointing at screens or whole flow boards -- each is
 * expanded to its individual screen frames. Screens live in per-feature files,
 * so the file key is read from each URL. See mockup-sync.ts.
 */
export async function syncMockupsFromFigmaAction(
  urls: string,
): Promise<SyncMockupsResult & { error?: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  try {
    const refs: FigmaRef[] = urls
      .split(/[\r\n]+/)
      .map((line) => parseFigmaRef(line))
      .filter((r): r is FigmaRef => Boolean(r));
    if (refs.length === 0) {
      throw new Error("Couldn't parse any Figma screen/board URLs. Paste links with a node-id, one per line.");
    }

    const result = await syncMockupsFromFigma(workspaceId, refs);
    revalidatePath("/design-system/mockups");
    return result;
  } catch (err) {
    return { imported: 0, removed: 0, errors: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rebuilds a Figma reference screen as a Storybook story composed from the real
 * design-system components (vision-grounded on the screenshot + structure), and
 * commits it to the design-system repo. Requires the screen's components to be
 * generated (committed) so the story can import them.
 */
export async function rebuildScreenOnDs(mockupId: string): Promise<{ ok: boolean; prUrl?: string; error?: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  try {
    const [m] = await db
      .select()
      .from(mockup)
      .where(and(eq(mockup.id, mockupId), eq(mockup.workspaceId, workspaceId)))
      .limit(1);
    if (!m || m.source !== "figma" || !m.previewBlobUrl) {
      return { ok: false, error: "Not a Figma reference screen." };
    }

    const committed = await db
      .select({
        slug: designComponent.slug,
        name: designComponent.name,
        isIcon: designComponent.isIcon,
        variants: designComponent.variants,
        states: designComponent.states,
      })
      .from(designComponent)
      .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.codeSyncStatus, "committed")));
    if (committed.length === 0) {
      return { ok: false, error: "No design-system components are generated yet — generate them first." };
    }

    const model = await getEffectiveModel(workspaceId, "design-system-codegen");
    const res = await fetch(m.previewBlobUrl, { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `Couldn't load the screenshot (${res.status}).` };
    const bytes = new Uint8Array(await res.arrayBuffer());

    const slug = m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `screen-${mockupId.slice(0, 8)}`;
    const story = await generateScreenStory(model, {
      slug,
      screenName: m.name,
      screenshot: { bytes, mediaType: "image/png" },
      structureText: m.structureText,
      catalog: buildComponentCatalog(committed as CatalogComponent[]),
    });

    const branch = await getOrOpenSessionBranch(workspaceId);
    await commitFiles(branch, `Rebuild screen ${story.storyName} from Figma`, [
      { path: story.storyPath, content: story.content },
    ]);
    const { prUrl } = await finishCodeGenSession(branch);

    revalidatePath("/design-system/mockups");
    return { ok: true, prUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteMockup(id: string) {
  const workspaceId = await getCurrentWorkspaceId();
  const [row] = await db
    .select()
    .from(mockup)
    .where(and(eq(mockup.id, id), eq(mockup.workspaceId, workspaceId)))
    .limit(1);
  if (row) {
    // Clean up whichever Blob objects this mockup owns: the HTML page
    // (manual/ai) and/or the screenshot (a Figma reference).
    if (row.blobUrl) await del(row.blobUrl).catch(() => {});
    if (row.previewBlobUrl) await del(row.previewBlobUrl).catch(() => {});
    await db.delete(mockup).where(eq(mockup.id, id));
  }
  revalidatePath("/design-system/mockups");
}

/** Saves edited HTML content from the mockup edit page — mirrors documents/actions.ts updateDocumentContent. */
export async function updateMockupContent(id: string, formData: FormData) {
  const content = String(formData.get("content") ?? "");

  const workspaceId = await getCurrentWorkspaceId();
  const [row] = await db
    .select()
    .from(mockup)
    .where(and(eq(mockup.id, id), eq(mockup.workspaceId, workspaceId)))
    .limit(1);
  if (!row) {
    redirect("/design-system/mockups");
  }

  const previousBlobUrl = row.blobUrl;

  try {
    const blob = await put(`mockups/${Date.now()}-${row.filename}`, content, {
      access: "public",
      addRandomSuffix: true,
    });

    await db
      .update(mockup)
      .set({ blobUrl: blob.url, status: "ready", errorMessage: null, updatedAt: new Date() })
      .where(eq(mockup.id, id));

    if (previousBlobUrl) await del(previousBlobUrl).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(mockup)
      .set({ status: "error", errorMessage: message, updatedAt: new Date() })
      .where(eq(mockup.id, id));
  }

  revalidatePath("/design-system/mockups");
  revalidatePath(`/design-system/mockups/${id}`);
  redirect(`/design-system/mockups/${id}`);
}
