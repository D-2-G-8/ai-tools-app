import "server-only";

/**
 * Minimal GitLab REST v4 client for AI Review (see src/lib/code-review/*.ts,
 * code-review-actions.ts). Deliberately dependency-free (plain fetch) --
 * matches this codebase's existing preference (see src/lib/ingest/embed.ts's
 * Voyage client) over pulling in an SDK for three endpoints.
 *
 * Auth is always PRIVATE-TOKEN + a per-request { gitlabUrl, token } pair --
 * the token comes from the signed-in user's session (src/lib/session.ts)
 * and is NEVER persisted to the DB (see PLAN.md, section 3).
 */

export interface GitlabAuth {
  gitlabUrl: string;
  token: string;
}

export interface GitlabMergeRequest {
  projectId: string;
  iid: number;
  title: string;
  webUrl: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface GitlabProjectMrs {
  projectId: string;
  mrs: GitlabMergeRequest[];
  error?: string;
}

export interface GitlabDiffFile {
  newPath: string | null;
  oldPath: string | null;
  diff: string;
}

function apiBase(gitlabUrl: string): string {
  return `${gitlabUrl.replace(/\/+$/, "")}/api/v4`;
}

async function gitlabFetch<T>(
  { gitlabUrl, token }: GitlabAuth,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBase(gitlabUrl)}${path}`, {
    ...init,
    headers: {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitLab API returned ${res.status} for ${path}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface RawMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  author?: { username?: string; name?: string } | null;
  source_branch: string;
  target_branch: string;
}

/**
 * Fetches open MRs for each project independently and in parallel -- a
 * failure on one project (bad id, no access) doesn't take down the others,
 * it's just reported in that project's `error` field (mirrors the Python
 * prototype's collect_open_mrs, which does the same per-project isolation).
 */
export async function listOpenMergeRequests(auth: GitlabAuth, projectIds: string[]): Promise<GitlabProjectMrs[]> {
  return Promise.all(
    projectIds.map(async (projectId): Promise<GitlabProjectMrs> => {
      try {
        const raw = await gitlabFetch<RawMergeRequest[]>(
          auth,
          `/projects/${encodeURIComponent(projectId)}/merge_requests?state=opened&per_page=100`,
        );
        const mrs: GitlabMergeRequest[] = raw.map((mr) => ({
          projectId,
          iid: mr.iid,
          title: mr.title,
          webUrl: mr.web_url,
          author: mr.author?.name || mr.author?.username || "unknown",
          sourceBranch: mr.source_branch,
          targetBranch: mr.target_branch,
        }));
        return { projectId, mrs };
      } catch (err) {
        return { projectId, mrs: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}

interface RawMrChanges {
  changes?: { new_path: string | null; old_path: string | null; diff?: string | null }[];
}

export async function fetchMrDiff(auth: GitlabAuth, projectId: string, iid: number): Promise<GitlabDiffFile[]> {
  const raw = await gitlabFetch<RawMrChanges>(
    auth,
    `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/changes`,
  );
  return (raw.changes ?? []).map((c) => ({
    newPath: c.new_path,
    oldPath: c.old_path,
    diff: c.diff ?? "",
  }));
}

export async function postMrComment(auth: GitlabAuth, projectId: string, iid: number, body: string): Promise<void> {
  await gitlabFetch(auth, `/projects/${encodeURIComponent(projectId)}/merge_requests/${iid}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
