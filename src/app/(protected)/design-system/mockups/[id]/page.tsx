import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMockupForWorkspace, mockupStatusClass } from "../shared";

export const dynamic = "force-dynamic";

export default async function MockupViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const m = await loadMockupForWorkspace(id);
  if (!m) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/design-system/mockups" className="text-sm text-neutral-500 hover:underline">
          ← Back to mockups
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">{m.name}</h2>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${mockupStatusClass[m.status]}`}>{m.status}</span>
          </div>
          <p className="mt-1 text-sm text-neutral-500">{m.filename}</p>
          {m.status === "error" && m.errorMessage && (
            <p className="mt-1 text-sm text-red-600">{m.errorMessage}</p>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <Link href={`/design-system/mockups/${m.id}/edit`} className="hover:underline">
            Edit
          </Link>
          <a href={`/design-system/mockups/${m.id}/download`} className="hover:underline">
            Download
          </a>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <iframe
          src={`/design-system/mockups/${m.id}/render`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={m.name}
          className="h-[80vh] w-full"
        />
      </div>
    </div>
  );
}
