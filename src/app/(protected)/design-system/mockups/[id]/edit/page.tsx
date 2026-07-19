import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMockupForWorkspace, loadMockupContent } from "../../shared";
import { updateMockupContent } from "../../actions";

export const dynamic = "force-dynamic";

export default async function MockupEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const m = await loadMockupForWorkspace(id);
  if (!m) notFound();

  const { content, error: contentError } = await loadMockupContent(m.blobUrl);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/design-system/mockups/${m.id}`} className="text-sm text-neutral-500 hover:underline">
          ← Back to mockup
        </Link>
      </div>

      <div>
        <h2 className="text-xl font-semibold">Edit {m.filename}</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Manual HTML edit — keep it self-contained (no external asset references) so it keeps rendering
          correctly out of Blob storage.
        </p>
      </div>

      {contentError ? (
        <p className="text-sm text-red-600">Couldn&apos;t load the file content: {contentError}</p>
      ) : (
        <form action={updateMockupContent.bind(null, m.id)} className="flex flex-col gap-3">
          <textarea
            name="content"
            defaultValue={content}
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
              Save
            </button>
            <Link href={`/design-system/mockups/${m.id}`} className="text-sm text-neutral-500 hover:underline">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
