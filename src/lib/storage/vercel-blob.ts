import "server-only";
import { put, del } from "@vercel/blob";
import type { StorageDriver } from "./types";

/** Thin pass-through to @vercel/blob -- the default driver, used whenever
 *  STORAGE_DRIVER is unset (i.e. every existing Vercel deployment keeps
 *  working with zero new environment variables). */
export const vercelBlobDriver: StorageDriver = {
  async put(path, content, opts) {
    const blob = await put(path, content, {
      access: "public",
      addRandomSuffix: opts?.addRandomSuffix ?? false,
      ...(opts?.contentType ? { contentType: opts.contentType } : {}),
    });
    return { url: blob.url };
  },
  async del(url) {
    await del(url);
  },
};
