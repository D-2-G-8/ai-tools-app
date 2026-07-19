"use server";

import { put } from "@vercel/blob";

/**
 * Uploads a single image (screenshot/photo the user attaches while editing a
 * document, see components/document-edit-form.tsx) to Blob and returns a
 * markdown image reference for it. Deliberately not tied to any document row
 * -- an image is just another public Blob object; it becomes part of a
 * document only once its `![alt](url)` reference is pasted into that
 * document's markdown and saved.
 *
 * Called directly from the client component (not through a <form action>),
 * so it returns a value instead of redirecting -- same "use server" export
 * mechanism, just invoked as a plain async function.
 *
 * Known limitation (see README): deleting a document does not clean up any
 * image Blobs it referenced -- they're not tracked anywhere. Acceptable for
 * an MVP; revisit if this starts accumulating meaningful storage cost.
 */
export async function uploadDocumentImage(
  formData: FormData,
): Promise<{ url: string; alt: string } | { error: string }> {
  const file = formData.get("image");
  if (!(file instanceof File)) {
    return { error: "No image found in the form" };
  }
  if (!file.type.startsWith("image/")) {
    return { error: `"${file.name}" doesn't look like an image (${file.type || "unknown type"})` };
  }

  try {
    const blob = await put(`documents/images/${Date.now()}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });

    const alt = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "screenshot";
    return { url: blob.url, alt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Upload failed: ${message}` };
  }
}
