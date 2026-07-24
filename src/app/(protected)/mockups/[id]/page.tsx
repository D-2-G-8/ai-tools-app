import Link from "next/link";
import { notFound } from "next/navigation";
import { loadMockupForWorkspace, mockupStatusClass } from "../shared";
import { RebuildScreenButton } from "./rebuild-screen-button";

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
        <Link href="/mockups" className="text-sm text-neutral-500 hover:underline">
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
          {m.source !== "figma" && (
            <>
              <Link href={`/mockups/${m.id}/edit`} className="hover:underline">
                Edit
              </Link>
              <a href={`/mockups/${m.id}/download`} className="hover:underline">
                Download
              </a>
            </>
          )}
        </div>
      </div>

      {m.source === "figma" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="mb-1 text-xs font-medium text-neutral-500">Rebuild on the design system</h3>
            <p className="mb-3 text-xs text-neutral-400">
              Generate a Storybook story that recreates this screen from the design-system components (grounded on
              the screenshot + structure), and open a PR in the design-system repo.
            </p>
            <RebuildScreenButton mockupId={m.id} />
          </div>
          {m.previewBlobUrl && (
            <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.previewBlobUrl} alt={m.name} className="mx-auto max-h-[70vh] w-auto" />
            </div>
          )}
          {m.usesComponents.length > 0 && (
            <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm">
              <h3 className="mb-2 text-xs font-medium text-neutral-500">Design-system components on this screen</h3>
              <div className="flex flex-wrap gap-2">
                {m.usesComponents.map((slug) => (
                  <span
                    key={slug}
                    className="rounded border border-neutral-200 px-2 py-0.5 text-xs text-neutral-700"
                  >
                    {slug}
                  </span>
                ))}
              </div>
            </div>
          )}
          {m.structureText && (
            <details className="rounded-lg border border-neutral-200 bg-white p-4">
              <summary className="cursor-pointer text-xs font-medium text-neutral-500">
                Structure spec (distilled from Figma)
              </summary>
              <pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap text-[11px] text-neutral-600">
                {m.structureText}
              </pre>
            </details>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <iframe
            src={`/mockups/${m.id}/render`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={m.name}
            className="h-[80vh] w-full"
          />
        </div>
      )}
    </div>
  );
}
