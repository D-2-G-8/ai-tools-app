"use server";

import { redirect } from "next/navigation";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { company, companyInvite, user, workspace } from "@/db/schema";
import { getCurrentUser } from "@/db/users";

/**
 * Creates a brand-new company and makes the signed-in user its owner.
 *
 * The very first company ever created on this instance adopts the pre-auth
 * default `workspace` row (the one every document/setting created before
 * this feature shipped lives on) instead of starting from a blank slate --
 * see schema.ts's `workspace.companyId` comment. Every company created
 * after that gets a fresh, empty workspace.
 */
export async function createCompany(formData: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/sign-in");
  if (currentUser.companyId) redirect("/");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const existingCompanies = await db.select({ id: company.id }).from(company).limit(1);
  const isFirstCompanyEver = existingCompanies.length === 0;

  const [newCompany] = await db.insert(company).values({ name, createdByUserId: currentUser.id }).returning();

  await db.update(user).set({ companyId: newCompany.id, companyRole: "owner" }).where(eq(user.id, currentUser.id));

  if (isFirstCompanyEver) {
    const [legacyWorkspace] = await db.select().from(workspace).where(isNull(workspace.companyId)).limit(1);

    if (legacyWorkspace) {
      await db.update(workspace).set({ companyId: newCompany.id }).where(eq(workspace.id, legacyWorkspace.id));
    } else {
      await db.insert(workspace).values({ companyId: newCompany.id });
    }
  } else {
    await db.insert(workspace).values({ companyId: newCompany.id });
  }

  redirect("/");
}

/**
 * Joins the signed-in user to the company behind a pending invite for their
 * email address. No email is ever sent for invites (see companyInvite's
 * doc comment in schema.ts) -- this action is what actually activates one,
 * the first time the invitee signs in with Google and lands here.
 */
export async function acceptInvite(formData: FormData) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/sign-in");
  if (currentUser.companyId) redirect("/");

  const inviteId = String(formData.get("inviteId") ?? "");
  if (!inviteId) return;

  const [invite] = await db.select().from(companyInvite).where(eq(companyInvite.id, inviteId)).limit(1);

  if (!invite || invite.status !== "pending" || invite.email !== currentUser.email.toLowerCase()) {
    return;
  }

  await db
    .update(user)
    .set({ companyId: invite.companyId, companyRole: "member" })
    .where(eq(user.id, currentUser.id));

  await db
    .update(companyInvite)
    .set({ status: "accepted", acceptedAt: new Date() })
    .where(eq(companyInvite.id, invite.id));

  redirect("/");
}
