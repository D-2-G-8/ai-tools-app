"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { companyInvite } from "@/db/schema";
import { getCurrentUser } from "@/db/users";

async function requireOwner() {
  const currentUser = await getCurrentUser();
  if (!currentUser?.companyId || currentUser.companyRole !== "owner") {
    throw new Error("Only the company owner can do this");
  }
  return currentUser as typeof currentUser & { companyId: string };
}

/**
 * Owner-only. No email is actually sent (no transactional-email provider in
 * this app, see schema.ts's companyInvite comment) -- this just records the
 * invite; the invitee auto-joins the next time they sign in with Google
 * using that exact address (see src/app/onboarding/page.tsx).
 */
export async function inviteMember(formData: FormData) {
  const owner = await requireOwner();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return;

  // The (companyId, email) unique index makes re-inviting an already-pending
  // address a no-op instead of a duplicate row.
  await db
    .insert(companyInvite)
    .values({ companyId: owner.companyId, email, invitedByUserId: owner.id })
    .onConflictDoNothing();

  revalidatePath("/company");
}

export async function revokeInvite(inviteId: string) {
  const owner = await requireOwner();

  await db
    .delete(companyInvite)
    .where(
      and(
        eq(companyInvite.id, inviteId),
        eq(companyInvite.companyId, owner.companyId),
        eq(companyInvite.status, "pending"),
      ),
    );

  revalidatePath("/company");
}
