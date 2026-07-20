import "server-only";
import { getCurrentUser } from "@/db/users";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getValidFigmaAccessToken } from "@/lib/figma/client";
import { syncDesignSystemFromFigma, type SyncProgressEvent } from "@/lib/figma/sync";

export const dynamic = "force-dynamic";
// Same allowance as the rest of this app's slow actions (see
// design-system/settings/page.tsx) -- a full sync can take a while for a
// large file, and streaming progress doesn't change Vercel's hard cap on
// total invocation time.
export const maxDuration = 60;

/**
 * Streams live progress for a Figma sync (src/lib/figma/sync.ts) via
 * Server-Sent Events, consumed by the <FigmaSyncButton> client component on
 * the design-system Settings page. GET + EventSource on purpose, not a
 * POST the client fetches manually: this endpoint needs no request body at
 * all (workspace id comes from the session, file key + access token are
 * looked up server-side), so EventSource's built-in reconnect/parsing is
 * simpler than hand-rolling a fetch() stream reader for no real benefit.
 *
 * Replaces the old redirect-based "Sync now" Server Action
 * (design-system/settings/actions.ts's now-removed syncFigmaDesignSystem)
 * -- that gave zero visibility into a sync that could run for a while with
 * only a single request/response at the end.
 */
export async function GET() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    // Not a redirect to /sign-in: EventSource expects text/event-stream on
    // success and just treats any non-2xx as a connection error it can
    // inspect -- redirecting into an HTML page would look like a garbled
    // stream to the client, not a clean "you're signed out."
    return new Response("Unauthorized", { status: 401 });
  }

  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const fileKey = ws?.figmaFileKey?.trim();
  if (!fileKey) {
    return new Response("Set a Figma file key in Settings first, then sync.", { status: 400 });
  }

  const accessToken = await getValidFigmaAccessToken();
  if (!accessToken) {
    return new Response("Figma isn't connected (or the connection expired) -- connect it again in Settings.", {
      status: 400,
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: SyncProgressEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        const result = await syncDesignSystemFromFigma(workspaceId, fileKey, accessToken, send);

        revalidatePath("/design-system/settings");
        revalidatePath("/design-system");
        revalidatePath("/design-system/components");

        const skippedNote =
          result.tokensSkipped > 0 ? ` (${result.tokensSkipped} style(s) couldn't be resolved and were skipped)` : "";
        send({
          phase: "done",
          message: `Synced ${result.tokensUpserted} token(s) and ${result.componentsUpserted} component(s)${skippedNote}.`,
          result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ phase: "error", message });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable response buffering on self-hosted deploys behind nginx (see
      // docker-compose/README self-hosted section) -- without this, nginx
      // can buffer the whole response and defeat the live-progress point.
      "X-Accel-Buffering": "no",
    },
  });
}
