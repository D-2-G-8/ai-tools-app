import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { SetupNotice } from "@/components/setup-notice";
import { saveDesignSettings } from "./actions";

export const dynamic = "force-dynamic";

const STACK_OPTIONS = [
  { value: "react-scss", label: "React + SCSS" },
  { value: "react-css-modules", label: "React + CSS Modules (.module.scss)" },
  { value: "none", label: "No component code generation yet" },
];

async function loadWorkspace() {
  const workspaceId = await getCurrentWorkspaceId();
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  return ws;
}

export default async function DesignSettingsPage() {
  let ws: Awaited<ReturnType<typeof loadWorkspace>> | null = null;
  let loadError: unknown = null;
  try {
    ws = await loadWorkspace();
  } catch (err) {
    loadError = err;
  }

  if (loadError || !ws) {
    return <SetupNotice error={loadError} />;
  }

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-medium text-neutral-700 mb-1">Figma source</h2>
        <p className="mb-4 text-xs text-neutral-400">
          The file key used when syncing tokens and components from Figma. Syncing itself currently runs
          from a Claude session with access to this file (via the Figma MCP connector) — a per-user Figma
          token in Settings, for syncing straight from the app, is a possible follow-up.
        </p>
        <form action={saveDesignSettings} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Figma file key</span>
            <input
              name="figmaFileKey"
              defaultValue={ws.figmaFileKey ?? ""}
              placeholder="e.g. OcaHeBKMqemoZZt2C5z0wd"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-mono"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-600">Component code stack</span>
            <select
              name="componentStack"
              defaultValue={ws.designComponentStack}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            >
              {STACK_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="submit"
            className="self-start rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
