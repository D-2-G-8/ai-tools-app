import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { company, companyInvite, run, user } from "@/db/schema";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { isOnline } from "@/lib/presence";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { getTool } from "@/lib/tools/registry";
import { inviteMember, revokeInvite } from "./actions";

function toolDisplayName(toolKey: string): string {
  if (toolKey === "documents-qa") return "Documents Q&A";
  if (toolKey === "document-format") return "Document formatting";
  return getTool(toolKey)?.name ?? toolKey;
}

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

  // Company-wide token/cost usage -- "sколько потратили токенов и какие
  // модели использовались и где" (which models, and where -- i.e. which
  // tool). Every run across every member of this company, broken down two
  // ways: by tool + model, and by member.
  const workspaceId = await getCurrentWorkspaceId();
  const usageStatsSelect = {
    runs: sql<number>`count(*)`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(${run.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${run.outputTokens}), 0)`.mapWith(Number),
    costUsd: sql<number>`coalesce(sum(${run.costEstimateUsd}), 0)`.mapWith(Number),
  };
  const usageByToolModel = await db
    .select({ toolKey: run.toolKey, model: run.model, ...usageStatsSelect })
    .from(run)
    .where(eq(run.workspaceId, workspaceId))
    .groupBy(run.toolKey, run.model)
    .orderBy(sql`sum(${run.costEstimateUsd}) desc`);
  const usageByMember = await db
    .select({ userId: run.userId, ...usageStatsSelect })
    .from(run)
    .where(eq(run.workspaceId, workspaceId))
    .groupBy(run.userId)
    .orderBy(sql`sum(${run.costEstimateUsd}) desc`);

  const memberById = new Map(members.map((m) => [m.id, m]));
  const totalCostUsd = usageByToolModel.reduce((sum, r) => sum + r.costUsd, 0);
  const totalRuns = usageByToolModel.reduce((sum, r) => sum + r.runs, 0);

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

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">Usage</h2>
        <p className="mb-4 text-xs text-neutral-400">
          Token/cost totals across every member of this company, from LLM calls made by any tool (see each
          tool&apos;s own &quot;Stats&quot; tab for just your own usage on that tool).
        </p>

        {totalRuns === 0 ? (
          <p className="text-sm text-neutral-400">No runs yet — data will appear after the first tool run.</p>
        ) : (
          <div className="flex flex-col gap-6">
            <p className="text-sm text-neutral-600">
              <span className="font-medium">${totalCostUsd.toFixed(4)}</span> spent across{" "}
              <span className="font-medium">{totalRuns}</span> runs, company-wide.
            </p>

            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 mb-2">By tool and model</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-neutral-500">
                    <th className="py-2 font-medium">Tool</th>
                    <th className="py-2 font-medium">Model</th>
                    <th className="py-2 font-medium">Runs</th>
                    <th className="py-2 font-medium">Tokens (in/out)</th>
                    <th className="py-2 font-medium">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {usageByToolModel.map((row) => (
                    <tr key={`${row.toolKey}-${row.model}`} className="border-b border-neutral-100">
                      <td className="py-2">{toolDisplayName(row.toolKey)}</td>
                      <td className="py-2">{row.model}</td>
                      <td className="py-2">{row.runs}</td>
                      <td className="py-2">
                        {row.inputTokens} / {row.outputTokens}
                      </td>
                      <td className="py-2">${row.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400 mb-2">By member</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-neutral-500">
                    <th className="py-2 font-medium">Member</th>
                    <th className="py-2 font-medium">Runs</th>
                    <th className="py-2 font-medium">Tokens (in/out)</th>
                    <th className="py-2 font-medium">Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {usageByMember.map((row) => {
                    const member = row.userId ? memberById.get(row.userId) : undefined;
                    const label = member?.name ?? member?.email ?? "Before per-user tracking / removed member";
                    return (
                      <tr key={row.userId ?? "unknown"} className="border-b border-neutral-100">
                        <td className="py-2">{label}</td>
                        <td className="py-2">{row.runs}</td>
                        <td className="py-2">
                          {row.inputTokens} / {row.outputTokens}
                        </td>
                        <td className="py-2">${row.costUsd.toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
