import Link from "next/link";
import { db } from "@/db";
import { designToken, workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDefaultWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";

export const dynamic = "force-dynamic";

const categoryLabel: Record<string, string> = {
  color: "Color",
  typography: "Typography",
  spacing: "Spacing",
  radius: "Radius",
  shadow: "Shadow",
  duration: "Duration",
  other: "Other",
};

async function loadTokens() {
  const workspaceId = await getDefaultWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const tokens = await db.select().from(designToken).where(eq(designToken.workspaceId, workspaceId));

  const byCategory = new Map<string, typeof tokens>();
  for (const token of tokens) {
    const list = byCategory.get(token.category) ?? [];
    list.push(token);
    byCategory.set(token.category, list);
  }

  return { ws, byCategory };
}

export default async function DesignTokensPage() {
  let data: Awaited<ReturnType<typeof loadTokens>> | null = null;
  let loadError: unknown = null;
  try {
    data = await loadTokens();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !data) {
    return <SetupNotice error={loadError} />;
  }

  const { ws, byCategory } = data;

  if (byCategory.size === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <p className="text-sm text-neutral-600">No tokens synced yet.</p>
        <p className="mt-1 text-sm text-neutral-400">
          {ws?.figmaFileKey
            ? "A Figma file is configured — sync tokens from it on the Settings tab."
            : "Configure a Figma file on the Settings tab, then sync tokens from it."}
        </p>
        <Link
          href="/design-system/settings"
          className="mt-4 inline-block rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
        >
          Go to Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {Array.from(byCategory.entries()).map(([category, tokens]) => (
        <section key={category}>
          <h2 className="text-sm font-medium text-neutral-600 mb-3">
            {categoryLabel[category] ?? category} ({tokens.length})
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white p-3 text-sm"
              >
                {category === "color" && (
                  <span
                    className="h-8 w-8 shrink-0 rounded border border-neutral-200"
                    style={{ backgroundColor: token.value }}
                  />
                )}
                <div className="min-w-0">
                  <div className="font-medium truncate">{token.name}</div>
                  <div className="truncate text-xs text-neutral-400">{token.value}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
