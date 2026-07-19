import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { company, companyInvite, user } from "@/db/schema";
import { getCurrentUser } from "@/db/users";
import { isOnline } from "@/lib/presence";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { inviteMember, revokeInvite } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Phase 1's answer to "who's in the company" -- a static roster (name,
 * email, role, joined date) plus owner-only invites. This is NOT live
 * online/offline presence -- that's Phase 2, not part of this page.
 */
export default async function CompanyPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.companyId) {
    // Unreachable in practice -- src/app/(protected)/layout.tsx already
    // redirects to /onboarding before this page can render for a user with
    // no company.
    return null;
  }
  const companyId = currentUser.companyId;

  const [companyRow] = await db.select().from(company).where(eq(company.id, companyId)).limit(1);
  const members = await db.select().from(user).where(eq(user.companyId, companyId)).orderBy(user.createdAt);
  const pendingInvites = await db
    .select()
    .from(companyInvite)
    .where(and(eq(companyInvite.companyId, companyId), eq(companyInvite.status, "pending")))
    .orderBy(companyInvite.createdAt);

  const isOwner = currentUser.companyRole === "owner";

  return (
    <div className="flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">{companyRow?.name ?? "Company"}</h1>
        <p className="mt-1 text-neutral-500">
          Everyone in your company shares the same uploaded documents and project context.
        </p>
      </div>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-4">
          Members ({members.length})
          {" · "}
          {members.filter((m) => isOnline(m.lastSeenAt)).length} online now
        </h2>
        <ul className="flex flex-col gap-2">
          {members.map((m) => {
            const online = isOnline(m.lastSeenAt);
            return (
              <li
                key={m.id}
                className="flex items-center justify-between rounded-md border border-neutral-100 p-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{m.name ?? m.email}</div>
                  <div className="text-xs text-neutral-400 truncate">{m.email}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
                  <span
                    className={`flex items-center gap-1 ${online ? "text-emerald-600" : "text-neutral-400"}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : "bg-neutral-300"}`} />
                    {online ? "online" : m.lastSeenAt ? `last seen ${formatRelativeTime(m.lastSeenAt)}` : "never signed in"}
                  </span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5">{m.companyRole}</span>
                  <span>joined {m.createdAt.toLocaleDateString()}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700 mb-4">Invite by email</h2>
          <p className="text-xs text-neutral-400 mb-3">
            No invite email is sent — let the person know yourself. They join automatically the next time they sign
            in with Google using that address.
          </p>
          <form action={inviteMember} className="flex items-center gap-3">
            <input
              type="email"
              name="email"
              required
              placeholder="teammate@example.com"
              className="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              Invite
            </button>
          </form>

          {pendingInvites.length > 0 && (
            <ul className="mt-4 flex flex-col gap-2">
              {pendingInvites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between rounded-md border border-neutral-100 p-2 text-sm"
                >
                  <span className="text-neutral-600">{invite.email}</span>
                  <form action={revokeInvite.bind(null, invite.id)}>
                    <button type="submit" className="text-xs text-red-600 hover:underline">
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
