import "server-only";
import type { StorageDriver, PutContent, PutOptions, PutResult } from "./types";

/**
 * File storage driver selector -- STORAGE_DRIVER=s3 (Docker/self-hosted,
 * see docker-compose.yml) or unset/"vercel-blob" (every existing Vercel
 * deployment, default -- needs zero new environment variables).
 *
 * The driver module is loaded lazily via dynamic import, resolved once and
 * cached, so that:
 * - `next build` never requires live credentials for either driver (same
 *   spirit as the lazy Proxy-based DB init in src/db/index.ts).
 * - Deployments using the default vercel-blob driver never pull the (much
 *   larger) AWS SDK into their bundled serverless function.
 *
 * Call sites (documents/actions.ts, documents/image-actions.ts,
 * mockups/actions.ts, tools/[toolKey]/chat-actions.ts) only ever use
 * `put`/`del` -- import from here instead of "@vercel/blob" and nothing
 * else about them needs to change.
 */

let cachedDriver: Promise<StorageDriver> | undefined;

function getDriver(): Promise<StorageDriver> {
  if (!cachedDriver) {
    cachedDriver =
      process.env.STORAGE_DRIVER === "s3"
        ? import("./s3").then((m) => m.s3Driver)
        : import("./vercel-blob").then((m) => m.vercelBlobDriver);
  }
  return cachedDriver;
}

export async function put(path: string, content: PutContent, opts?: PutOptions): Promise<PutResult> {
  const driver = await getDriver();
  return driver.put(path, content, opts);
}

export async function del(url: string): Promise<void> {
  const driver = await getDriver();
  return driver.del(url);
}
