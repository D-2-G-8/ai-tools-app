"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { workspace, componentStackValues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { disconnectFigmaSession } from "@/lib/session";
import { getValidFigmaAccessToken } from "@/lib/figma/client";
import { syncDesignSystemFromFigma } from "@/lib/figma/sync";

const SETTINGS_PATH = "/design-system/settings";

function errorRedirect(message: string): never {
  redirect(`${SETTINGS_PATH}?figma=error&figmaMessage=${encodeURIComponent(message)}`);
}

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

/**
 * "Sync now" button -- pulls styles/components from the configured Figma
 * file (src/lib/figma/sync.ts) into design_token/design_component. Not a
 * client component / useActionState: like the rest of this app's simple
 * action buttons (see documents/page.tsx's retry/delete forms), feedback is
 * a redirect with a result in the query string, read by the page below.
 */
export async function syncFigmaDesignSystem() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const fileKey = ws?.figmaFileKey?.trim();
  if (!fileKey) {
    errorRedirect("Set a Figma file key above first, then sync.");
  }

  const accessToken = await getValidFigmaAccessToken();
  if (!accessToken) {
    errorRedirect("Figma isn't connected (or the connection expired) -- connect it again above.");
  }

  let result: Awaited<ReturnType<typeof syncDesignSystemFromFigma>>;
  try {
    result = await syncDesignSystemFromFigma(workspaceId, fileKey, accessToken);
  } catch (err) {
    errorRedirect(err instanceof Error ? err.message : String(err));
  }

  revalidatePath(SETTINGS_PATH);
  revalidatePath("/design-system");
  revalidatePath("/design-system/components");
  redirect(
    `${SETTINGS_PATH}?figma=synced&tokens=${result.tokensUpserted}&skipped=${result.tokensSkipped}&components=${result.componentsUpserted}`,
  );
}
