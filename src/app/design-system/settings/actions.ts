"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, componentStackValues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";

export async function saveDesignSettings(formData: FormData) {
  const workspaceId = await getDefaultWorkspaceId();

  const figmaFileKey = String(formData.get("figmaFileKey") ?? "").trim();
  const componentStackRaw = String(formData.get("componentStack") ?? "");
  const componentStack = (componentStackValues as readonly string[]).includes(componentStackRaw)
    ? componentStackRaw
    : "react-css-modules";

  await db
    .update(workspace)
    .set({ figmaFileKey: figmaFileKey || null, designComponentStack: componentStack })
    .where(eq(workspace.id, workspaceId));

  revalidatePath("/design-system/settings");
  revalidatePath("/design-system");
  revalidatePath("/design-system/components");
}
