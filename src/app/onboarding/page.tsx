import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { company, companyInvite } from "@/db/schema";
import { getCurrentUser } from "@/db/users";
import { acceptInvite, createCompany } from "./actions";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/sign-in");
  // Already onboarded -- e.g. they navigated back here manually.
  if (currentUser.companyId) redirect("/");

  const invites = await db
    .select({ id: companyInvite.id, companyName: company.name })
    .from(companyInvite)
    .innerJoin(company, eq(companyInvite.companyId, company.id))
    .where(and(eq(companyInvite.email, currentUser.email.toLowerCase()), eq(companyInvite.status, "pending")));

  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 p-8">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="text-center">
          <h1 className="text-xl font-semibold">Welcome, {currentUser.name ?? currentUser.email}</h1>
          <p className="mt-1 text-sm text-neutral-500">Join an existing company or create a new one to get started.</p>
        </div>

        {invites.map((invite) => (
          <section key={invite.id} className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-sm font-medium text-neutral-700">
              You&apos;ve been invited to join <span className="font-semibold">{invite.companyName}</span>
            </h2>
            <form action={acceptInvite} className="mt-3">
              <input type="hidden" name="inviteId" value={invite.id} />
              <button type="submit" className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-700">
                Accept &amp; join
              </button>
            </form>
          </section>
        ))}

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-medium text-neutral-700">Create a new company</h2>
          <form action={createCompany} className="mt-3 flex flex-col gap-3">
            <input name="name" required placeholder="Company name" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm" />
            <button type="submit" className="rounded-md border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50">
              Create company
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
