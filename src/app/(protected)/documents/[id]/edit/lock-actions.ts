"use server";

import { acquireOrRenewEditLock, releaseEditLockIfOwned } from "@/db/edit-lock";

/** Called from the client heartbeat while the edit page is open -- keeps
 * the lock (src/db/edit-lock.ts) alive well inside its TTL. */
export async function renewEditLock(documentId: string) {
  await acquireOrRenewEditLock(documentId).catch(() => {});
}

/** Called when the edit page unmounts (save, cancel, or navigating away). */
export async function releaseEditLock(documentId: string) {
  await releaseEditLockIfOwned(documentId).catch(() => {});
}
