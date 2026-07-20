import "server-only";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { StorageDriver, PutContent } from "./types";

/**
 * S3-compatible driver (MinIO for the bundled self-hosted/Docker setup, or
 * real AWS S3) -- used when STORAGE_DRIVER=s3 (see ./index.ts).
 *
 * `blobUrl` is stored permanently in the DB (document/mockup tables) and
 * fetched an unknown time later, always server-side (never embedded into
 * browser-rendered HTML -- confirmed across every consumer of `blobUrl`).
 * So this driver always returns a STABLE, NON-EXPIRING URL (never a
 * presigned one), and the same S3_ENDPOINT used to write objects is also
 * what's stored/fetched later -- no need for a separate public endpoint.
 * The bucket itself must be configured for public-read (see
 * docker-compose.yml's minio-init service, `mc anonymous set download`) --
 * the same trust model this app already uses for Vercel Blob's
 * `access: "public"`, just self-operated infrastructure instead of a
 * managed service.
 */

let cachedClient: S3Client | undefined;

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set -- required when STORAGE_DRIVER=s3. See .env.example.`);
  }
  return value;
}

function getClient(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      endpoint: getEnv("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: getEnv("S3_ACCESS_KEY_ID"),
        secretAccessKey: getEnv("S3_SECRET_ACCESS_KEY"),
      },
    });
  }
  return cachedClient;
}

function endpointBase(): string {
  return getEnv("S3_ENDPOINT").replace(/\/+$/, "");
}

async function toBuffer(content: PutContent): Promise<{ body: Buffer; contentType?: string }> {
  if (typeof content === "string") {
    return { body: Buffer.from(content, "utf-8") };
  }
  const arrayBuffer = await content.arrayBuffer();
  return { body: Buffer.from(arrayBuffer), contentType: content.type || undefined };
}

/** Mirrors @vercel/blob's own random-suffix behavior closely enough for
 *  this app's purposes: inserted before the file extension (if any). */
function withRandomSuffix(path: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot > lastSlash) {
    return `${path.slice(0, lastDot)}-${suffix}${path.slice(lastDot)}`;
  }
  return `${path}-${suffix}`;
}

export const s3Driver: StorageDriver = {
  async put(path, content, opts) {
    const key = opts?.addRandomSuffix ? withRandomSuffix(path) : path;
    const bucket = getEnv("S3_BUCKET");
    const { body, contentType: inferredContentType } = await toBuffer(content);

    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType ?? inferredContentType,
      }),
    );

    return { url: `${endpointBase()}/${bucket}/${key}` };
  },
  async del(url) {
    const bucket = getEnv("S3_BUCKET");
    const prefix = `${endpointBase()}/${bucket}/`;
    const key = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  },
};
