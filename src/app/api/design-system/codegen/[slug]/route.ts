import "server-only";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { db } from "@/db";
import { workspace, designComponent } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getEffectiveModel } from "@/lib/tools/model-settings";
import { generateComponentCode, type ComponentForCodegen } from "@/lib/design-system-codegen/component";
import { loadTokensForCss } from "@/lib/design-system-codegen/data";
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
    return Response.json({ ok: false, error: "Missing ?branch= query param." }, { status: 400 });
  }

  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  if (!ws || ws.designComponentStack === "none") {
    return Response.json({ ok: false, error: "Code generation is off for this workspace (Settings)." }, { status: 400 });
  }
  if (ws.designComponentStack !== "react-css-modules") {
    return Response.json(
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
    return Response.json({ ok: false, error: `Component "${slug}" not found.` }, { status: 404 });
  }

  await db.update(designComponent).set({ codeSyncStatus: "pending" }).where(eq(designComponent.id, component.id));

  try {
    const model = await getEffectiveModel(workspaceId, "design-system-codegen");
    const tokens = await loadTokensForCss(workspaceId);
    const forCodegen: ComponentForCodegen = {
      slug: component.slug,
      name: component.name,
      description: component.description ?? undefined,
      variants: component.variants,
      states: component.states,
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

    return Response.json({ ok: true, componentName: generated.componentName, commitSha: sha });
  } catch (err) {
    await db.update(designComponent).set({ codeSyncStatus: "failed" }).where(eq(designComponent.id, component.id));
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
