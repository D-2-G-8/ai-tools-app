"use client";

import { useEffect } from "react";
import { renewEditLock, releaseEditLock } from "@/app/(protected)/documents/[id]/edit/lock-actions";

const RENEW_INTERVAL_MS = 60 * 1000;

/**
 * Keeps the edit lock (src/db/edit-lock.ts) alive while this component is
 * mounted, and releases it as soon as the edit page unmounts (Save
 * redirects away, Cancel navigates away, or the user clicks elsewhere in
 * the app). A hard tab close/crash skips this cleanup -- that's what the
 * lock's TTL protects against.
 */
export function EditLockHeartbeat({ documentId }: { documentId: string }) {
  useEffect(() => {
    const interval = setInterval(() => {
      renewEditLock(documentId).catch(() => {});
    }, RENEW_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      releaseEditLock(documentId).catch(() => {});
    };
  }, [documentId]);

  return null;
}
