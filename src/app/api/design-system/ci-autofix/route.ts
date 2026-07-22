import "server-only";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { autofixTypeErrorsFromCi } from "@/lib/design-system-codegen/ci-autofix";

export const dynamic = "force-dynamic";
// One round of CI-typecheck-feedback autofix, bounded on its own (a handful
// of holisticFix LLM calls, see ci-autofix.ts's MAX_FIX_PER_CLICK) -- same
// budget as the per-component codegen route (codegen/[slug]/route.ts).
export const maxDuration = 60;

/**
 * POST /api/design-system/ci-autofix
 *
 * Reads the design-system CI's latest typecheck result for the workspace's
 * currently-open PR branch and, on failure, fixes up to a bounded number of
 * affected components and commits the fixes back onto that branch. Never
 * opens a PR itself -- see autofixTypeErrorsFromCi's doc comment.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getCurrentWorkspaceId();
  try {
    const result = await autofixTypeErrorsFromCi(workspaceId, user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
