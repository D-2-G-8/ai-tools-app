import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { visualReviewComponent } from "@/lib/design-system-codegen/visual-review";

export const dynamic = "force-dynamic";
// One component's screenshot + vision-diff + (at most) one holisticFix LLM
// call and commit -- same per-click budget as ci-autofix/route.ts and
// codegen/[slug]/route.ts.
export const maxDuration = 60;

/**
 * POST /api/design-system/visual-review/[slug]
 *
 * Screenshots the component's Storybook story, vision-diffs it against its
 * real Figma render, and (if findings surface) applies the same holistic
 * autofix the other codegen routes use, committing back onto the workspace's
 * pending PR branch. Never opens a PR itself -- see visualReviewComponent's
 * doc comment.
 *
 * Visual findings never block: this always answers 200 (the loading/diff/fix
 * states are reported in the body's `status`/`fixed` fields), since a vision
 * outage or an unfixed finding is advisory, not a reason to fail the request.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const { slug } = await params;
  const workspaceId = await getCurrentWorkspaceId();
  const result = await visualReviewComponent(workspaceId, user.id, slug);
  return NextResponse.json({ ok: result.status === "reviewed", ...result }, { status: 200 });
}
