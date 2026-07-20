/**
 * Plain liveness check -- no DB call, so it stays fast and doesn't fail
 * just because migrations are still running. Used by the Dockerfile's
 * HEALTHCHECK and docker-compose.yml's `depends_on: condition:
 * service_healthy` for the app service (see docker-compose.yml).
 */
export async function GET() {
  return new Response("ok", { status: 200 });
}
