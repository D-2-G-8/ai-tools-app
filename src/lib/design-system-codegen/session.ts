import "server-only";
import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateBranch } from "@/lib/github/client";

/**
 * Returns the branch a code-sync commit should land on: reuses the
 * workspace's currently-open PR's branch if one exists (workspace.
 * designSystemPendingPrBranch) -- so a full "Generate code" run and later
 * targeted resyncs ("Resync this component", "Resync tokens") all pile
 * commits onto the same not-yet-merged PR instead of opening parallel
 * duplicate ones -- else mints a fresh timestamped session branch.
 * Idempotent either way: getOrCreateBranch is a no-op (just returns the
 * current SHA) if the branch already exists.
 */
export async function getOrOpenSessionBranch(workspaceId: string): Promise<string> {
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const branchName = ws?.designSystemPendingPrBranch || `figma-sync-${Date.now()}`;
  await getOrCreateBranch(branchName);
  return branchName;
}
