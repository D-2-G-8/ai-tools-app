"use client";

import { useEffect } from "react";
import { touchPresence } from "@/app/(protected)/presence-actions";

const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Keeps the signed-in user's presence fresh while a protected page is open,
 * even if they never navigate (e.g. reading one document for several
 * minutes) -- see src/app/(protected)/presence-actions.ts and
 * src/lib/presence.ts.
 */
export function PresenceHeartbeat() {
  useEffect(() => {
    touchPresence().catch(() => {});
    const interval = setInterval(() => {
      touchPresence().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return null;
}
