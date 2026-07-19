"use client";

import { useActionState, useState } from "react";
import {
  runReview,
  estimateV3Review,
  postReviewToGitlab,
  type RunReviewState,
  type EstimateV3State,
  type PostToGitlabState,
} from "@/app/(protected)/tools/[toolKey]/code-review-actions";
import type { ReviewVersion } from "@/lib/code-review/schema";
import type { GitlabProjectMrs, GitlabMergeRequest } from "@/lib/gitlab/client";
import type { CodeReviewFindingRecord } from "@/db/schema";

interface DocumentOption {
  id: string;
  filename: string;
}

interface CodeReviewPanelProps {
  ready: boolean;
  setupMessage?: string;
  projects: GitlabProjectMrs[];
  documents: DocumentOption[];
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2 };
const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-yellow-100 text-yellow-800",
};

function FindingsList({ findings }: { findings: CodeReviewFindingRecord[] }) {
  const confirmed = [...findings]
    .filter((f) => f.verdict !== "needs_verification")
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const toVerify = findings.filter((f) => f.verdict === "needs_verification");

  if (findings.length === 0) {
    return <p className="text-sm text-emerald-700">No issues found ✅</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {confirmed.length > 0 && (
        <ul className="flex flex-col gap-2">
          {confirmed.map((f, i) => (
            <li key={`${f.file}-${i}`} className="rounded-md border border-neutral-200 bg-white p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_BADGE[f.severity] ?? "bg-neutral-100 text-neutral-700"}`}>
                  {f.severity}
                </span>
                <span className="font-mono text-xs text-neutral-500">{f.file}</span>
                {f.agreement !== undefined && <span className="text-xs text-neutral-400">{f.agreement}× agreement</span>}
              </div>
              <p className="mt-1 font-medium text-neutral-900">{f.bug}</p>
              <p className="mt-0.5 text-neutral-600">{f.why}</p>
            </li>
          ))}
        </ul>
      )}
      {toVerify.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-600">Needs verification</p>
          <ul className="flex flex-col gap-2">
            {toVerify.map((f, i) => (
              <li key={`${f.file}-verify-${i}`} className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_BADGE[f.severity] ?? "bg-neutral-100 text-neutral-700"}`}>
                    {f.severity}
                  </span>
                  <span className="font-mono text-xs text-neutral-500">{f.file}</span>
                </div>
                <p className="mt-1 font-medium text-neutral-900">{f.bug}</p>
                <p className="mt-0.5 text-neutral-600">{f.why}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

async function noopPostAction(prev: PostToGitlabState, _formData: FormData): Promise<PostToGitlabState> {
  void _formData;
  return prev;
}

function MergeRequestCard({ mr, documents }: { mr: GitlabMergeRequest; documents: DocumentOption[] }) {
  const [version, setVersion] = useState<ReviewVersion>("v1");
  const [contextDocIds, setContextDocIds] = useState<string[]>([]);

  const boundRun = runReview.bind(null, mr.projectId, mr.iid, version);
  const [runState, runAction, runPending] = useActionState<RunReviewState, FormData>(boundRun, {});

  const boundEstimate = estimateV3Review.bind(null, mr.projectId, mr.iid);
  const [estimateState, estimateAction, estimatePending] = useActionState<EstimateV3State, FormData>(boundEstimate, {});

  const boundPost = runState.runId ? postReviewToGitlab.bind(null, runState.runId) : noopPostAction;
  const [postState, postAction, postPending] = useActionState<PostToGitlabState, FormData>(boundPost, {});

  const v3NeedsEstimate = version === "v3" && estimateState.estimatedCostUsd === undefined;

  return (
    <li className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <a href={mr.webUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-neutral-900 hover:underline">
            !{mr.iid} {mr.title}
          </a>
          <p className="text-xs text-neutral-500">
            {mr.author} · {mr.sourceBranch} → {mr.targetBranch}
          </p>
        </div>
        <select
          value={version}
          onChange={(e) => setVersion(e.target.value as ReviewVersion)}
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        >
          <option value="v1">V1 — single model</option>
          <option value="v2">V2 — two models + judge</option>
          <option value="v3">V3 — multi-agent (expensive)</option>
        </select>
      </div>

      {version === "v3" && (
        <div className="mt-3 rounded-md border border-dashed border-neutral-300 p-3">
          <p className="mb-2 text-xs font-medium text-neutral-600">
            Documents with full feature context (business requirements / system analysis / ADR):
          </p>
          {documents.length === 0 ? (
            <p className="text-xs text-neutral-400">No documents uploaded yet -- V3 will run context-blind for all agents.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {documents.map((doc) => (
                <label key={doc.id} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    checked={contextDocIds.includes(doc.id)}
                    onChange={(e) =>
                      setContextDocIds((prev) => (e.target.checked ? [...prev, doc.id] : prev.filter((id) => id !== doc.id)))
                    }
                  />
                  {doc.filename}
                </label>
              ))}
            </div>
          )}

          <form action={estimateAction} className="mt-3 flex flex-wrap items-center gap-3">
            {contextDocIds.map((id) => (
              <input key={id} type="hidden" name="contextDoc" value={id} />
            ))}
            <button
              type="submit"
              disabled={estimatePending}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50"
            >
              {estimatePending ? "Estimating…" : "Estimate cost"}
            </button>
            {estimateState.estimatedCostUsd !== undefined && (
              <span className="text-xs text-neutral-600">Estimated: ~${estimateState.estimatedCostUsd.toFixed(4)}</span>
            )}
            {estimateState.error && <span className="text-xs text-red-600">{estimateState.error}</span>}
          </form>
        </div>
      )}

      <form action={runAction} className="mt-3 flex flex-wrap items-center gap-3">
        <input type="hidden" name="mrTitle" value={mr.title} />
        <input type="hidden" name="sourceBranch" value={mr.sourceBranch} />
        <input type="hidden" name="targetBranch" value={mr.targetBranch} />
        {version === "v3" && contextDocIds.map((id) => <input key={id} type="hidden" name="contextDoc" value={id} />)}
        <button
          type="submit"
          disabled={runPending || v3NeedsEstimate}
          title={v3NeedsEstimate ? "Estimate the cost first" : undefined}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {runPending ? "Reviewing…" : `Run ${version.toUpperCase()} review`}
        </button>
        {runState.costUsd !== undefined && <span className="text-xs text-neutral-500">Cost: ${runState.costUsd.toFixed(4)}</span>}
        {runState.truncated && <span className="text-xs text-amber-600">Diff truncated -- not all changes were analyzed</span>}
      </form>

      {runState.error && <p className="mt-2 text-xs text-red-600">{runState.error}</p>}

      {runState.findings && (
        <div className="mt-4 border-t border-neutral-100 pt-3">
          <FindingsList findings={runState.findings} />
          <form action={postAction} className="mt-3">
            <button
              type="submit"
              disabled={postPending || postState.posted}
              className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50"
            >
              {postState.posted ? "Posted to MR ✓" : postPending ? "Posting…" : "Post to MR"}
            </button>
            {postState.error && <span className="ml-2 text-xs text-red-600">{postState.error}</span>}
          </form>
        </div>
      )}
    </li>
  );
}

export function CodeReviewPanel({ ready, setupMessage, projects, documents }: CodeReviewPanelProps) {
  if (!ready) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">AI Review isn&apos;t set up yet</p>
        <p className="mt-1">{setupMessage}</p>
      </div>
    );
  }

  const totalMrs = projects.reduce((sum, p) => sum + p.mrs.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Code Review</h1>
        <p className="mt-1 text-neutral-500">
          AI Review of open GitLab merge requests. V1 is a single cheap model; V2 cross-checks two models with a
          judge; V3 runs multiple agents (some with full feature context, some fresh-eyed) and costs the most --
          estimate before running it.
        </p>
      </div>

      {projects.some((p) => p.error) && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {projects
            .filter((p) => p.error)
            .map((p) => (
              <p key={p.projectId}>
                {p.projectId}: {p.error}
              </p>
            ))}
        </div>
      )}

      {totalMrs === 0 ? (
        <p className="text-sm text-neutral-400">No open merge requests found.</p>
      ) : (
        projects
          .filter((p) => p.mrs.length > 0)
          .map((p) => (
            <section key={p.projectId}>
              <h2 className="mb-2 text-sm font-medium text-neutral-600">{p.projectId}</h2>
              <ul className="flex flex-col gap-3">
                {p.mrs.map((mr) => (
                  <MergeRequestCard key={`${mr.projectId}-${mr.iid}`} mr={mr} documents={documents} />
                ))}
              </ul>
            </section>
          ))
      )}
    </div>
  );
}
