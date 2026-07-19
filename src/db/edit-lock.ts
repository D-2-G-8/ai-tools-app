import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "./index";
import { document } from "./schema";
import { getCurrentUser } from "./users";

/**
 * How long an edit lock stays valid without being renewed before it's
 * treated as abandoned and ignored -- protects against a crashed tab or
 * closed browser locking a document forever. The client-side heartbeat
 * (src/components/edit-lock-heartbeat.tsx) renews well inside this window
 * while the edit page is actually open.
 */
export const EDIT_LOCK_TTL_MS = 3 * 60 * 1000;

export type EditLockResult = { ok: true } | { ok: false; lockedByUserId: string; lockedAt: Date };

/**
 * Atomically acquires the edit lock for `documentId` for the signed-in
 * user, or refreshes it if they already hold it. A single UPDATE ... WHERE
 * ... RETURNING makes the check-and-set race-safe under concurrent
 * requests -- of two people opening the edit page at the same moment, only
 * one can win it.
 */
export async function acquireOrRenewEditLock(documentId: string): Promise<EditLockResult> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("acquireOrRenewEditLock() called without a signed-in user");
  }

  const staleBefore = new Date(Date.now() - EDIT_LOCK_TTL_MS);

  // Retry once: if the UPDATE loses the race but the lock turns out to
  // already be free/stale by the time we look (e.g. it was released
  // concurrently in between), retry instead of incorrectly reporting it as
  // still held.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [updated] = await db
      .update(document)
      .set({ editLockedByUserId: currentUser.id, editLockedAt: new Date() })
      .where(
        and(
          eq(document.id, documentId),
          or(
            isNull(document.editLockedByUserId),
            eq(document.editLockedByUserId, currentUser.id),
            lt(document.editLockedAt, staleBefore),
          ),
        ),
      )
      .returning({ id: document.id });

    if (updated) return { ok: true };

    const [doc] = await db.select().from(document).where(eq(document.id, documentId)).limit(1);
    if (!doc) return { ok: true }; // document gone -- let the caller's own lookup 404 it
    if (!doc.editLockedByUserId || !doc.editLockedAt || doc.editLockedAt < staleBefore) {
      continue; // lock is actually free/stale now -- retry the UPDATE
    }
    return { ok: false, lockedByUserId: doc.editLockedByUserId, lockedAt: doc.editLockedAt };
  }

  // Should be unreachable in practice; fail open rather than blocking
  // editing forever if something odd happens above.
  return { ok: true };
}

/** Releases the lock only if the signed-in user is the one currently holding it. */
export async function releaseEditLockIfOwned(documentId: string): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return;

  await db
    .update(document)
    .set({ editLockedByUserId: null, editLockedAt: null })
    .where(and(eq(document.id, documentId), eq(document.editLockedByUserId, currentUser.id)));
}
