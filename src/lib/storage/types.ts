/**
 * Storage driver abstraction so document/mockup/image uploads work
 * identically on Vercel (Blob) and self-hosted (S3-compatible, e.g. MinIO)
 * deployments -- see vercel-blob.ts, s3.ts, and index.ts (the driver
 * selector actually imported by call sites).
 *
 * Deliberately narrow: mirrors only the subset of @vercel/blob's `put`/`del`
 * call shape this codebase actually uses (no `list`/`head`), so switching
 * driver never requires touching a call site beyond the import line.
 */

export type PutContent = string | File;

export interface PutOptions {
  /** Vercel Blob's `access: "public"` is the only mode this app uses -- both
   *  drivers always write publicly-readable objects, this option exists
   *  just to keep the call sites' existing `{ access: "public", ... }`
   *  object literals valid without edits. */
  access?: "public";
  /** Appends a short random suffix to the key to avoid collisions --
   *  mirrors @vercel/blob's own option of the same name. */
  addRandomSuffix?: boolean;
  contentType?: string;
}

export interface PutResult {
  url: string;
}

export interface StorageDriver {
  put(path: string, content: PutContent, opts?: PutOptions): Promise<PutResult>;
  del(url: string): Promise<void>;
}
