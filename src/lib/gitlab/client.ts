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

const GITLAB_FETCH_TIMEOUT_MS = 15_000;

/**
 * Node's fetch() (undici) throws a bare "fetch failed" Error on any
 * network-level failure -- DNS lookup, TLS handshake, connection refused,
 * timeout -- with the actual reason nested in `err.cause` (sometimes an
 * AggregateError with one entry per attempted address for dual-stack
 * lookups). Without unwrapping this, every unreachable-host failure in the
 * AI Review UI shows the same useless "fetch failed" for every project ID,
 * which is what actually prompted this: see the per-project errors from
 * listOpenMergeRequests below.
 */
export function describeGitlabError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof AggregateError !== "undefined" && current instanceof AggregateError) {
      const inner = current.errors.map((e) => (e instanceof Error ? e.message : String(e)));
      parts.push(...inner.filter((m) => !parts.includes(m)));
      break;
    }
    if (current instanceof Error) {
      if (!parts.includes(current.message)) parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" -- caused by: ");
}

async function gitlabFetch<T>(
  { gitlabUrl, token }: GitlabAuth,
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(gitlabUrl)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(GITLAB_FETCH_TIMEOUT_MS),
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    // Rethrow with the unwrapped cause baked into the message -- this is
    // what reaches the per-project `error` field and the run's errorMessage
    // in code-review-actions.ts, so it needs to be diagnostic on its own.
    throw new Error(`Could not reach ${apiBase(gitlabUrl)} -- ${describeGitlabError(err)}`);
  }
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
        return { projectId, mrs: [], error: describeGitlabError(err) };
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
