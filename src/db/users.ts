import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "./index";
import { user } from "./schema";

export type CurrentUser = typeof user.$inferSelect;

/**
 * Returns the signed-in user's current row from the database, or null if
 * not signed in. Always a fresh DB read -- companyId/companyRole are
 * deliberately not cached in the session JWT (see src/auth.ts), so this is
 * the single source of truth for "what company is this person in right
 * now." Cheap enough to call once per request/render; do not add a
 * module-level cache here (it would leak one user's/company's data across
 * requests, the same bug this task is fixing in src/db/workspace.ts).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const rows = await db.select().from(user).where(eq(user.id, session.user.id)).limit(1);
  return rows[0] ?? null;
}
