/**
 * How recently a user's `lastSeenAt` must be to count as "online" (company
 * roster, sidebar badge). Kept fresh by touchPresence() -- see
 * src/app/(protected)/presence-actions.ts -- on page loads and via a
 * client-side heartbeat (src/components/presence-heartbeat.tsx) so it stays
 * accurate even while someone sits on one page without navigating.
 */
export const PRESENCE_ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function isOnline(lastSeenAt: Date | null): boolean {
  return lastSeenAt !== null && Date.now() - lastSeenAt.getTime() < PRESENCE_ONLINE_WINDOW_MS;
}
