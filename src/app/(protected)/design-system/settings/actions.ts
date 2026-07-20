"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, componentStackValues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { disconnectFigmaSession } from "@/lib/session";

const SETTINGS_PATH = "/design-system/settings";

export async function saveDesignSettings(formData: FormData) {
  const workspaceId = await getCurrentWorkspaceId();

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

/** "Disconnect" button next to the Figma connection status. */
export async function disconnectFigma() {
  await disconnectFigmaSession();
  revalidatePath(SETTINGS_PATH);
  redirect(`${SETTINGS_PATH}?figma=disconnected`);
}

// "Sync now" is now handled by src/app/api/figma/sync/route.ts (SSE) +
// figma-sync-button.tsx (client component) -- see that route's comment for
// why this moved off the old redirect-based Server Action pattern.
