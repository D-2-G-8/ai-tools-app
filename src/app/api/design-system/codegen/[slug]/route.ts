import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { db } from "@/db";
import { workspace, designComponent, run as runTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { generateComponentCodeReviewed, type ComponentForCodegen, type ChildContract } from "@/lib/design-system-codegen/component";
import type { Finding } from "@/lib/design-system-codegen/review";
import type { GeneratedComponentFiles } from "@/lib/design-system-codegen/paths";
import { buildIconComponentFiles } from "@/lib/design-system-codegen/icon";
import { fetchIconSvg } from "@/lib/design-system-codegen/icon-fetch";
import { loadTokensForCss } from "@/lib/design-system-codegen/data";
import { fetchComponentDesignSpec } from "@/lib/design-system-codegen/figma-node";
import { buildComponentIndex } from "@/lib/design-system-codegen/dependencies";
import { getValidFigmaAccessToken, describeFigmaError } from "@/lib/figma/client";
import { commitFiles, listBranchPaths } from "@/lib/github/client";

export const dynamic = "force-dynamic";
// One component's contract+TSX+CSS+stories generation and GitHub commit,
// bounded on its own -- NOT folded into the metadata sync route
// (src/app/api/figma/sync/route.ts, also maxDuration=60), which stays fast
// (pure DB upserts). A full "Generate code" run calls this once per
// component (see design-system-codegen-panel.tsx), so per-component cost
// stays well under this budget regardless of how many components exist.
export const maxDuration = 60;

/**
 * POST /api/design-system/codegen/[slug]?branch=<branchName>
 *
 * Generates one component's code and commits it to the given branch (an
 * existing branch -- see /api/design-system/codegen/start, which creates
 * it and commits tokens.css first). Never merges anything -- see
 * src/lib/github/client.ts's mergePullRequest doc comment for why that's a
 * separate, explicit, human-triggered step.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const currentUser = await getCurrentUser();
  if (!currentUser) return new Response("Unauthorized", { status: 401 });

  const { slug } = await params;
  const branch = new URL(request.url).searchParams.get("branch");
  if (!branch) {
    return NextResponse.json({ ok: false, error: "Missing ?branch= query param." }, { status: 400 });
  }

  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws || ws.designComponentStack === "none") {
    return NextResponse.json({ ok: false, error: "Code generation is off for this workspace (Settings)." }, { status: 400 });
  }
  if (ws.designComponentStack !== "react-css-modules") {
    return NextResponse.json(
      { ok: false, error: `"${ws.designComponentStack}" isn't implemented yet -- only react-css-modules.` },
      { status: 400 },
    );
  }

  const [component] = await db
    .select()
    .from(designComponent)
    .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.slug, slug)))
    .limit(1);
  if (!component) {
    return NextResponse.json({ ok: false, error: `Component "${slug}" not found.` }, { status: 404 });
  }

  await db.update(designComponent).set({ codeSyncStatus: "pending" }).where(eq(designComponent.id, component.id));

  // Declared outside the try block (not `const model = ...` inside it) so
  // the catch block below can still record which model a failed attempt
  // used, if it got that far -- block-scoped consts from inside try aren't
  // visible in catch.
  let model: string | undefined;
  let generatedContract: ChildContract | null = null;

  try {
    model = await getEffectiveModel(workspaceId, "design-system-codegen");
    const tokens = await loadTokensForCss(workspaceId);
    const figmaToken = ws.figmaFileKey ? await getValidFigmaAccessToken() : null;

    let generated: GeneratedComponentFiles;
    let reviewFindings: Finding[] = []; // populated by the reviewed LLM path; empty for icons

    // Icons are generated DETERMINISTICALLY from their real Figma SVG (no LLM):
    // the distilled text spec the LLM pipeline uses carries no vector geometry,
    // so an icon would otherwise have its `d` path hallucinated and its
    // stroke-vs-fill guessed -- which shipped invisible icons. See icon.ts.
    // Best-effort: if Figma can't render the node (null SVG) or the fetch
    // fails, fall through to the LLM pipeline rather than failing the run.
    let iconFiles: GeneratedComponentFiles | null = null;
    if (component.isIcon && ws.figmaFileKey && component.figmaNodeIds[0] && figmaToken) {
      try {
        const svg = await fetchIconSvg(ws.figmaFileKey, component.figmaNodeIds[0], figmaToken);
        if (svg) iconFiles = buildIconComponentFiles(component.slug, svg);
        else console.warn(`[codegen] Figma returned no SVG for icon ${slug}; falling back to LLM generation.`);
      } catch (err) {
        console.warn(`[codegen] icon SVG fetch failed for ${slug}, falling back to LLM: ${describeFigmaError(err)}`);
      }
    }

    if (iconFiles) {
      generated = iconFiles;
    } else {
      // Pull the component's REAL Figma design (sizes, radii, fills, layout,
      // typography, structure) so generation reproduces it instead of guessing
      // from variant labels, plus the design-system components it COMPOSES
      // (INSTANCE nodes -> import & render, not re-implement). Best-effort: if
      // Figma isn't connected (no token) or the file key is missing, or the
      // fetch fails, we fall back to label-only generation rather than failing.
      let designSpec: string | undefined;
      let uses: { slug: string; componentName: string; isIcon: boolean }[] | undefined;
      let childContracts = new Map<string, ChildContract>();
      if (ws.figmaFileKey && component.figmaNodeIds.length > 0 && figmaToken) {
        try {
          // Only committed components are composable -- their code exists to
          // import. Anything not yet generated stays flattened/inlined. In a
          // full run the orchestrator generates in dependency order so a
          // component's dependencies are committed by the time it runs.
          const committed = await db
            .select({
              slug: designComponent.slug,
              figmaNodeIds: designComponent.figmaNodeIds,
              isIcon: designComponent.isIcon,
              contractJson: designComponent.contractJson,
            })
            .from(designComponent)
            .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.codeSyncStatus, "committed")));
          const index = buildComponentIndex(committed);
          for (const c of committed) {
            if (c.contractJson) childContracts.set(c.slug, c.contractJson);
          }
          const design = await fetchComponentDesignSpec(
            ws.figmaFileKey,
            component.figmaNodeIds,
            figmaToken,
            tokens,
            index,
            component.slug,
          );
          if (design) {
            designSpec = design.spec;
            uses = design.uses.map((u) => ({ slug: u.slug, componentName: u.componentName, isIcon: u.isIcon }));
          }
        } catch (err) {
          console.warn(`[codegen] Figma design fetch failed for ${slug}, falling back to labels: ${describeFigmaError(err)}`);
        }
      }

      const forCodegen: ComponentForCodegen = {
        slug: component.slug,
        name: component.name,
        description: component.description ?? undefined,
        variants: component.variants,
        states: component.states,
        isIcon: component.isIcon,
        designSpec,
        uses,
      };
      const reviewed = await generateComponentCodeReviewed(model, forCodegen, tokens, childContracts);
      generated = reviewed;
      reviewFindings = reviewed.reviewFindings;
      generatedContract = reviewed.contract;
      if (!reviewed.reviewPassed) {
        // A build-breaking finding survived the autofix loop -- do NOT commit a
        // broken build. Mark failed and surface the findings.
        await db.update(designComponent).set({ codeSyncStatus: "failed" }).where(eq(designComponent.id, component.id));
        const summary = reviewed.reviewFindings.map((f) => `[${f.severity}] ${f.file}: ${f.message}`).join("; ");
        await db.insert(runTable).values({
          workspaceId,
          toolKey: "design-system-codegen",
          model,
          userId: currentUser.id,
          status: "error",
          inputSummary: `Generate ${component.name}`.slice(0, 500),
          errorMessage: `Review did not pass after autofix: ${summary}`.slice(0, 2000),
          inputTokens: reviewed.inputTokens,
          outputTokens: reviewed.outputTokens,
          costEstimateUsd: reviewed.costUsd.toFixed(6),
        });
        return NextResponse.json(
          { ok: false, error: `Review did not pass after autofix: ${summary}`.slice(0, 2000) },
          { status: 422 },
        );
      }
    }

    // Only delete legacy files that actually exist on the branch -- the Git
    // tree API 422s ("BadObjectState") on a deletion of a path that isn't
    // there (so a first-ever generation, with no legacy files, wouldn't fail).
    let deletions: string[] = [];
    if (generated.deletePaths.length > 0) {
      const onBranch = await listBranchPaths(branch);
      deletions = onBranch ? generated.deletePaths.filter((p) => onBranch.has(p)) : [];
    }

    const sha = await commitFiles(branch, `Generate ${generated.componentName} from Figma`, [
      { path: generated.tsxPath, content: generated.tsxContent },
      { path: generated.cssPath, content: generated.cssContent },
      { path: generated.storiesPath, content: generated.storiesContent },
      { path: generated.indexPath, content: generated.indexContent },
      ...deletions.map((path) => ({ path, content: null as string | null })),
    ]);

    await db
      .update(designComponent)
      .set({
        codeSyncStatus: "committed",
        lastCodeSyncAt: new Date(),
        lastCodeCommitSha: sha,
        ...(generatedContract ? { contractJson: generatedContract } : {}),
      })
      .where(eq(designComponent.id, component.id));

    // Same run/toolKey accounting every other tool gets (see
    // documents/format-actions.ts for the identical pattern) -- so this
    // shows up in the Company page's company-wide usage-by-tool table and
    // per-member breakdown, both of which group run rows by toolKey/userId
    // generically rather than only listing tools from the registry
    // (src/lib/tools/registry.ts -- "design-system-codegen" is deliberately
    // NOT registered there, it has no dedicated tool page of its own).
    await db.insert(runTable).values({
      workspaceId,
      toolKey: "design-system-codegen",
      model,
      userId: currentUser.id,
      status: "completed",
      inputSummary: `Generate ${component.name}`.slice(0, 500),
      outputSummary: `Committed ${generated.componentName} (${sha.slice(0, 7)})${
        reviewFindings.length ? ` -- ${reviewFindings.length} residual review note(s)` : ""
      }`.slice(0, 500),
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      costEstimateUsd: generated.costUsd.toFixed(6),
    });

    return NextResponse.json({ ok: true, componentName: generated.componentName, commitSha: sha });
  } catch (err) {
    await db.update(designComponent).set({ codeSyncStatus: "failed" }).where(eq(designComponent.id, component.id));
    const message = err instanceof Error ? err.message : String(err);

    // No token counts here -- generateComponentCodeReviewed throws before returning
    // anything on failure, same as every other tool's error-path run row
    // (e.g. documents/format-actions.ts), which also has no partial usage
    // to record.
    await db.insert(runTable).values({
      workspaceId,
      toolKey: "design-system-codegen",
      model: model ?? "unknown",
      userId: currentUser.id,
      status: "error",
      inputSummary: `Generate ${component.name}`.slice(0, 500),
      errorMessage: message.slice(0, 2000),
    });

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
