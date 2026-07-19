"use client";

import Link from "next/link";
import { useRef, useState, type ChangeEvent } from "react";
import { updateDocumentContent } from "@/app/documents/actions";
import { uploadDocumentImage } from "@/app/documents/image-actions";

/**
 * The document edit form, plus a way to attach a photo/screenshot while
 * editing: it uploads to Blob and inserts a markdown image reference at the
 * cursor. Saving re-ingests as usual (see actions.ts/updateDocumentContent)
 * -- ingest is what actually converts the image to text for the vector
 * index (see lib/ingest/images.ts); this component only gets the image
 * reference into the document's markdown.
 *
 * Pulled out of the edit page (a server component) because inserting text
 * into the textarea at the cursor needs client-side DOM access.
 */
export function DocumentEditForm({
  documentId,
  initialContent,
}: {
  documentId: string;
  initialContent: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const cursor = start + text.length;
    el.selectionStart = el.selectionEnd = cursor;
    el.focus();
  }

  async function handleImageSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow selecting the same file again
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.set("image", file);
      const result = await uploadDocumentImage(formData);
      if ("error" in result) {
        setUploadError(result.error);
        return;
      }
      insertAtCursor(`\n![${result.alt}](${result.url})\n`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <form action={updateDocumentContent.bind(null, documentId)} className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <label className="cursor-pointer rounded-md border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
          {uploading ? "Uploading…" : "Insert image / screenshot"}
          <input
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={handleImageSelected}
            className="hidden"
          />
        </label>
        <p className="text-xs text-neutral-400">
          Inserted as a markdown image — converted to text by a vision model for search when you save.
        </p>
      </div>
      {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}

      <textarea
        ref={textareaRef}
        name="content"
        defaultValue={initialContent}
        rows={30}
        required
        spellCheck={false}
        className="w-full rounded-lg border border-neutral-200 bg-white p-4 font-mono text-sm text-neutral-800"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Save and reprocess
        </button>
        <Link href={`/documents/${documentId}`} className="text-sm text-neutral-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  );
}
