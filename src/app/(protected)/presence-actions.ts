"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { getCurrentUser } from "@/db/users";

// Only actually write if the last recorded heartbeat is older than this --
// keeps a user rapidly navigating between pages (or an idle-tab heartbeat
// firing on its own interval) from hammering the DB with a write on every
// single request.
const PRESENCE_WRITE_DEDUPE_MS = 45 * 1000;

/**
 * Called on every protected page render (see (protected)/layout.tsx) and
 * from a client-side heartbeat (see components/presence-heartbeat.tsx) so
 * "online now" (src/lib/presence.ts) stays accurate even while someone
 * sits on a single page without navigating. Never throws -- presence is
 * best-effort and must never break a page render.
 */
export async function touchPresence() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return;

    const isStale =
      !currentUser.lastSeenAt || Date.now() - currentUser.lastSeenAt.getTime() > PRESENCE_WRITE_DEDUPE_MS;
    if (!isStale) return;

    await db.update(user).set({ lastSeenAt: new Date() }).where(eq(user.id, currentUser.id));
  } catch {
    // Best-effort -- presence must never break a page render or a client heartbeat.
  }
}
