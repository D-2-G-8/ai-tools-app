import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { db } from "@/db";
import { workspace, designComponent, run as runTable } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { generateComponentCode, type ComponentForCodegen } from "@/lib/design-system-codegen/component";
import { loadTokensForCss } from "@/lib/design-system-codegen/data";
import { fetchComponentDesignSpec } from "@/lib/design-system-codegen/figma-node";
import { buildComponentIndex } from "@/lib/design-system-codegen/dependencies";
import { getValidFigmaAccessToken, describeFigmaError } from "@/lib/figma/client";
import { commitFiles } from "@/lib/github/client";

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

  try {
    model = await getEffectiveModel(workspaceId, "design-system-codegen");
    const tokens = await loadTokensForCss(workspaceId);

    // Pull the component's REAL Figma design (sizes, radii, fills, layout,
    // typography, structure) so generation reproduces it instead of guessing
    // from variant labels, plus the design-system components it COMPOSES
    // (INSTANCE nodes -> import & render, not re-implement). Best-effort: if
    // Figma isn't connected (no token) or the file key is missing, or the
    // fetch fails, we fall back to label-only generation rather than failing.
    let designSpec: string | undefined;
    let uses: { slug: string; componentName: string }[] | undefined;
    if (ws.figmaFileKey && component.figmaNodeIds.length > 0) {
      try {
        const figmaToken = await getValidFigmaAccessToken();
        if (figmaToken) {
          // Only committed components are composable -- their code exists to
          // import. Anything not yet generated stays flattened/inlined. In a
          // full run the orchestrator generates in dependency order so a
          // component's dependencies are committed by the time it runs.
          const committed = await db
            .select({ slug: designComponent.slug, figmaNodeIds: designComponent.figmaNodeIds, isIcon: designComponent.isIcon })
            .from(designComponent)
            .where(and(eq(designComponent.workspaceId, workspaceId), eq(designComponent.codeSyncStatus, "committed")));
          const index = buildComponentIndex(committed);
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
            uses = design.uses.map((u) => ({ slug: u.slug, componentName: u.componentName }));
          }
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
    const generated = await generateComponentCode(model, forCodegen, tokens);

    const sha = await commitFiles(branch, `Generate ${generated.componentName} from Figma`, [
      { path: generated.tsxPath, content: generated.tsxContent },
      { path: generated.cssPath, content: generated.cssContent },
      { path: generated.storiesPath, content: generated.storiesContent },
      { path: generated.indexPath, content: generated.indexContent },
    ]);

    await db
      .update(designComponent)
      .set({ codeSyncStatus: "committed", lastCodeSyncAt: new Date(), lastCodeCommitSha: sha })
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
      outputSummary: `Committed ${generated.componentName} (${sha.slice(0, 7)})`.slice(0, 500),
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      costEstimateUsd: generated.costUsd.toFixed(6),
    });

    return NextResponse.json({ ok: true, componentName: generated.componentName, commitSha: sha });
  } catch (err) {
    await db.update(designComponent).set({ codeSyncStatus: "failed" }).where(eq(designComponent.id, component.id));
    const message = err instanceof Error ? err.message : String(err);

    // No token counts here -- generateComponentCode throws before returning
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
