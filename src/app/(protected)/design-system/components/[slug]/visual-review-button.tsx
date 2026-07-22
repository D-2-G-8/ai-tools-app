"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

type VisualReviewState = "idle" | "running" | "done" | "error";

interface VisualReviewResponse {
  ok: boolean;
  status: "reviewed" | "not-committed" | "no-branch" | "no-stand-url" | "no-figma" | "error";
  findingCount: number;
  fixed: boolean;
  sample: string[];
  error?: string;
}

const STATUS_HINT: Partial<Record<VisualReviewResponse["status"], string>> = {
  "not-committed": "Generate this component first.",
  "no-branch": "No active PR branch to preview.",
  "no-stand-url": "Set DESIGN_SYSTEM_STORYBOOK_URL_TEMPLATE to enable visual review.",
  "no-figma": "Figma not connected / no node.",
};

/**
 * "Visual review" on the component detail page: screenshots the component's
 * Storybook story, vision-diffs it against its real Figma render via
 * POST /api/design-system/visual-review/[slug] (see
 * src/lib/design-system-codegen/visual-review.ts), and -- if findings surface
 * -- reports whether a holistic autofix was committed onto the workspace's
 * pending PR branch.
 */
export function VisualReviewButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<VisualReviewState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [sample, setSample] = useState<string[]>([]);

  const run = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    setMessage(null);
    setSample([]);

    try {
      const res = await fetch(`/api/design-system/visual-review/${encodeURIComponent(slug)}`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as Partial<VisualReviewResponse>;
      if (!res.ok) {
        setState("error");
        setMessage(body.error ?? `HTTP ${res.status}`);
        return;
      }

      const status = body.status;
      if (status === "error") {
        setState("error");
        setMessage(body.error ?? "Visual review failed.");
        return;
      }

      if (status && status in STATUS_HINT) {
        setState("done");
        setMessage(STATUS_HINT[status] ?? null);
        router.refresh();
        return;
      }

      if (status === "reviewed") {
        const findingCount = body.findingCount ?? 0;
        if (findingCount === 0) {
          setState("done");
          setMessage("Matches the design ✓");
        } else if (body.fixed) {
          setState("done");
          setMessage(
            `${findingCount} visual finding(s) -- committed a fix. Storybook will redeploy; re-run to re-check.`,
          );
        } else {
          setState("done");
          setMessage(`${findingCount} finding(s) -- no fix committed`);
          setSample(body.sample ?? []);
        }
        router.refresh();
        return;
      }

      setState("error");
      setMessage("Unexpected response from visual review.");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [state, slug, router]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        className="self-start rounded-md border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "running" ? "Reviewing..." : "Visual review"}
      </button>

      {message && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            state === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
          }`}
        >
          {message}
        </p>
      )}

      {sample.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {sample.map((finding, i) => (
            <li key={i}>{finding}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
