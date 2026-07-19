import { eq } from "drizzle-orm";
import { db } from "./index";
import { workspace } from "./schema";
import { getCurrentUser } from "./users";

/**
 * Resolves the signed-in user's current company's workspace id.
 *
 * There is deliberately no module-level cache here -- there used to be
 * (`getDefaultWorkspaceId`, back when this app only ever had one single
 * global workspace), but caching a single id across all requests would leak
 * one company's workspace to every other company's users the moment a
 * second company existed. Each call does a fresh, cheap lookup instead.
 *
 * Throws if the signed-in user isn't in a company yet -- in practice this
 * is unreachable, since every page that can call this lives under
 * src/app/(protected), whose layout already redirects to /onboarding
 * before rendering anything for a user with no companyId.
 */
export async function getCurrentWorkspaceId(): Promise<string> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.companyId) {
    throw new Error("getCurrentWorkspaceId() called without a signed-in user in a company");
  }

  const existing = await db.select().from(workspace).where(eq(workspace.companyId, currentUser.companyId)).limit(1);
  if (existing.length > 0) {
    return existing[0].id;
  }

  // Defensive fallback -- every company gets its workspace created at
  // company-creation time (see src/app/onboarding/actions.ts), so this
  // insert should never actually run in practice.
  const [created] = await db.insert(workspace).values({ companyId: currentUser.companyId }).returning();
  return created.id;
}
