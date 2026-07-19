import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { getCurrentUser } from "@/db/users";
import { signOut } from "@/auth";
import { TOOLS } from "@/lib/tools/registry";
import { isOnline } from "@/lib/presence";
import { touchPresence } from "./presence-actions";
import { PresenceHeartbeat } from "@/components/presence-heartbeat";

/**
 * Access control for every page under this route group lives here, not in
 * middleware.ts. Reason: this app's Postgres driver (`postgres`, used in
 * src/db/index.ts) is a raw TCP client that does not work in Vercel's Edge
 * runtime, which is where middleware.ts runs by default. This layout is a
 * plain async Server Component (Node runtime), so it can safely do a fresh
 * DB read on every render via getCurrentUser() -- see src/auth.ts for the
 * corresponding note on why companyId is never cached in the session JWT.
 */

const navItems = [
  { href: "/", label: "Overview" },
  { href: "/documents", label: "Documents" },
  { href: "/design-system", label: "Design System" },
  { href: "/history", label: "History" },
  { href: "/company", label: "Company" },
  { href: "/settings", label: "Settings" },
];

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/sign-in");
  }
  if (!user.companyId) {
    redirect("/onboarding");
  }

  // Best-effort -- see presence-actions.ts, this never throws.
  await touchPresence();

  const companyMembers = await db
    .select({ lastSeenAt: userTable.lastSeenAt })
    .from(userTable)
    .where(eq(userTable.companyId, user.companyId));
  const onlineCount = companyMembers.filter((m) => isOnline(m.lastSeenAt)).length;

  return (
    <div className="min-h-full flex bg-neutral-50 text-neutral-900 font-sans">
      <PresenceHeartbeat />
      <aside className="w-64 shrink-0 border-r border-neutral-200 bg-white p-4 flex flex-col gap-6">
        <div className="text-lg font-semibold px-2">AI Tools Platform</div>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              <span>{item.label}</span>
              {item.href === "/company" && onlineCount > 0 && (
                <span className="flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {onlineCount} online
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="flex flex-col gap-1">
          <div className="px-2 text-xs font-medium uppercase tracking-wide text-neutral-400">Tools</div>
          {TOOLS.map((tool) => (
            <Link key={tool.key} href={`/tools/${tool.key}`} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100">
              <span>{tool.name}</span>
              {tool.status !== "active" && (
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {tool.status === "planned" ? "planned" : "in progress"}
                </span>
              )}
            </Link>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-2 border-t border-neutral-200 pt-4">
          <div className="px-2 text-sm text-neutral-700 truncate">{user.name ?? user.email}</div>
          <div className="px-2 text-xs text-neutral-400 truncate">{user.email}</div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/sign-in" });
            }}
          >
            <button type="submit" className="w-full rounded-md px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-8">{children}</main>
    </div>
  );
}
