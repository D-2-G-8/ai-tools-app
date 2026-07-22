import "server-only";
import { db } from "@/db";
import { workspace, designComponent, run as runTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { getValidFigmaAccessToken, getFileImages } from "@/lib/figma/client";
import { getBranchFile, commitFiles } from "@/lib/github/client";
import { captureScreenshot } from "@/lib/screenshot/client";
import { reviewVisualDiff } from "./visual-diff";
import { storybookStandUrl, storybookDefaultStoryId, componentSourcePaths } from "./paths";
import { fixComponentFiles, type ComponentForCodegen, type ChildContract, type ComponentContract } from "./component";
import { parseCompositionImports } from "./review/prop-types";
import { importSlug } from "./ci-map";
import { loadTokensForCss } from "./data";

export interface VisualReviewResult {
  status: "reviewed" | "not-committed" | "no-branch" | "no-stand-url" | "no-figma" | "error";
  findingCount: number;
  fixed: boolean;
  sample: string[];
  error?: string;
}

async function fetchPng(url: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Figma image fetch ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mediaType: "image/png" };
}

/**
 * Screenshot a committed component's default Storybook story, vision-diff it
 * against its real Figma render, and (if the diff surfaces findings) run the
 * same holistic autofix ci-autofix.ts uses to patch the files and commit them
 * back onto the workspace's pending PR branch.
 *
 * Deliberately mirrors ci-autofix.ts's component-loading pattern (branch read
 * straight off the workspace row, files read from that branch, uses/
 * childContracts built from the component's OWN tsx imports, contract
 * defaulted the same way) rather than getOrOpenSessionBranch -- this is a
 * read-mostly review loop that must never open a PR of its own; if there's no
 * pending branch yet, there's nothing to screenshot/commit against, so this
 * returns "no-branch" rather than minting one.
 *
 * Visual findings are advisory, never build-breaking: an absent/failed fix
 * still reports back with `fixed: false` and the findings in `sample`
 * instead of throwing, so callers (the route) can always answer 200.
 */
export async function visualReviewComponent(workspaceId: string, userId: string, slug: string): Promise<VisualReviewResult> {
  const base: VisualReviewResult = { status: "error", findingCount: 0, fixed: false, sample: [] };
  try {
    const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
    const [row] = await db
      .select()
      .from(designComponent)
      .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
      .limit(1);
    if (!row) return { ...base, error: `Component "${slug}" not found.` };
    if (row.codeSyncStatus !== "committed") return { ...base, status: "not-committed" };

    const branch = ws?.designSystemPendingPrBranch;
    if (!branch) return { ...base, status: "no-branch" };
    const stand = storybookStandUrl(branch, process.env.DESIGN_SYSTEM_STORYBOOK_URL_TEMPLATE ?? process.env.DESIGN_SYSTEM_STORYBOOK_URL);
    if (!stand) return { ...base, status: "no-stand-url" };
    if (!ws?.figmaFileKey || !row.figmaNodeIds[0]) return { ...base, status: "no-figma" };

    // rendered screenshot
    const storyUrl = `${stand}/iframe.html?id=${storybookDefaultStoryId(slug, row.isIcon)}&viewMode=story`;
    const rendered = await captureScreenshot(storyUrl);

    // figma reference
    const token = await getValidFigmaAccessToken();
    if (!token) return { ...base, status: "no-figma", error: "Figma not connected." };
    const images = await getFileImages(ws.figmaFileKey, [row.figmaNodeIds[0]], token, { format: "png", scale: 2 });
    const figmaImgUrl = images[row.figmaNodeIds[0]];
    if (!figmaImgUrl) return { ...base, status: "no-figma", error: "Figma could not render the component node." };
    const figma = await fetchPng(figmaImgUrl);

    const model = await getEffectiveModel(workspaceId, "design-system-codegen");
    const diff = await reviewVisualDiff(model, figma, rendered, componentSourcePaths(slug, row.isIcon).componentName);
    const sample = diff.findings.slice(0, 8).map((f) => f.message.slice(0, 140));
    if (diff.findings.length === 0) {
      return { status: "reviewed", findingCount: 0, fixed: false, sample: [] };
    }

    // apply -- reuse the ci-autofix loading pattern
    const paths = componentSourcePaths(slug, row.isIcon);
    const [tsx, css, stories] = await Promise.all([
      getBranchFile(branch, paths.tsxPath),
      getBranchFile(branch, paths.cssPath),
      getBranchFile(branch, paths.storiesPath),
    ]);
    if (tsx == null || !row.contractJson) {
      return { status: "reviewed", findingCount: diff.findings.length, fixed: false, sample };
    }
    const committed = await db
      .select({ slug: designComponent.slug, isIcon: designComponent.isIcon, contractJson: designComponent.contractJson })
      .from(designComponent)
      .where(eq(designComponent.workspaceId, workspaceId));
    const bySlug = new Map(committed.map((c) => [c.slug, c]));
    const childSlugs = [...new Set(parseCompositionImports(tsx).map((i) => importSlug(i.path)).filter((s): s is string => !!s))];
    const uses = childSlugs
      .map((s) => bySlug.get(s))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ slug: c.slug, componentName: componentSourcePaths(c.slug, c.isIcon).componentName, isIcon: c.isIcon }));
    const childContracts = new Map<string, ChildContract>();
    for (const u of uses) {
      const c = bySlug.get(u.slug);
      if (c?.contractJson) childContracts.set(u.slug, c.contractJson);
    }
    const availableTokens = await loadTokensForCss(workspaceId);

    const component: ComponentForCodegen = {
      slug: row.slug,
      name: row.name,
      description: row.description ?? undefined,
      variants: row.variants,
      states: row.states,
      isIcon: row.isIcon,
      designSpec: undefined,
      uses,
    };
    const contract: ComponentContract = {
      // StoredComponentContract's props.description is optional (older rows
      // predate it); the fixer's contract schema requires it, same default
      // ci-autofix.ts uses.
      props: row.contractJson.props.map((p) => ({ name: p.name, type: p.type, description: p.description ?? "" })),
      cssVariables: row.contractJson.cssVariables ?? [],
      classNames: row.contractJson.classNames ?? [],
    };
    const result = await fixComponentFiles(
      model,
      component,
      contract,
      { tsx, css: css ?? "", stories: stories ?? "", index: "" },
      diff.findings,
      childContracts,
      availableTokens,
    );
    await commitFiles(branch, `Visual review fixes for ${paths.componentName}`, [
      { path: paths.tsxPath, content: result.files.tsx },
      { path: paths.cssPath, content: result.files.css },
      { path: paths.storiesPath, content: result.files.stories },
    ]);
    // costEstimateUsd omitted -- same reasoning as ci-autofix.ts's run row: a
    // targeted visual-review fix, not a full generation, has no cost the way
    // generateComponentCode's estimateCostUsd call does.
    await db.insert(runTable).values({
      workspaceId,
      toolKey: "design-system-codegen",
      model,
      userId,
      status: "completed",
      inputSummary: `Visual review ${row.name}`.slice(0, 500),
      outputSummary: `Applied ${diff.findings.length} visual finding(s)`.slice(0, 500),
      inputTokens: diff.inputTokens + result.inputTokens,
      outputTokens: diff.outputTokens + result.outputTokens,
    });
    return { status: "reviewed", findingCount: diff.findings.length, fixed: true, sample };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
