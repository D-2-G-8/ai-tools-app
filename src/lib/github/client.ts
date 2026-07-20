import "server-only";

/**
 * Minimal GitHub REST client for committing AI-generated design-system
 * code (see src/lib/design-system-codegen/) into the separate
 * `design-system` repo as a reviewable pull request -- never directly to
 * the base branch (see design-system/settings's "Confirm & merge" flow).
 *
 * Deliberately dependency-free (plain fetch), matching this codebase's
 * existing preference (src/lib/gitlab/client.ts, src/lib/figma/client.ts)
 * over pulling in @octokit/* for a handful of endpoints.
 *
 * Auth is a single company-wide token (GITHUB_TOKEN), NOT per-user session
 * storage like GitLab/Figma -- committing to a shared repo other UI
 * services depend on is a platform action, not a personal one. Same
 * precedent as FIGMA_CLIENT_ID/VOYAGE_API_KEY (see src/lib/session.ts's
 * doc comment and src/lib/ingest/embed.ts).
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function getConfig(): { owner: string; repo: string; token: string; baseBranch: string } {
  const token = process.env.GITHUB_TOKEN;
  const repoSlug = process.env.GITHUB_DESIGN_SYSTEM_REPO;
  if (!token || !repoSlug) {
    throw new Error(
      "GITHUB_TOKEN and GITHUB_DESIGN_SYSTEM_REPO must be set to commit generated design-system code " +
        "(e.g. GITHUB_DESIGN_SYSTEM_REPO=D-2-G-8/design-system). See README's Design system code sync section.",
    );
  }
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_DESIGN_SYSTEM_REPO must look like "owner/repo", got "${repoSlug}".`);
  }
  return {
    owner,
    repo,
    token,
    baseBranch: process.env.GITHUB_DESIGN_SYSTEM_BASE_BRANCH || "master",
  };
}

/**
 * Node/undici's fetch() throws a bare "fetch failed" on network-level
 * errors -- same issue src/lib/gitlab/client.ts's describeGitlabError
 * already solved, reused here verbatim so GitHub errors are just as
 * diagnosable.
 */
export function describeGithubError(err: unknown): string {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A single sync session makes many more GitHub calls than this codebase's
 * other integrations do in one user action (one branch fetch/create + a
 * blob+tree+commit+ref-update per file group, times however many
 * components changed) -- unlike GitLab/Figma's existing zero-retry
 * pattern (fine for a single user-triggered call), this surface benefits
 * from a small bounded retry so one transient 5xx/network blip doesn't
 * fail an entire sync session. Only retries network failures and 5xx/429
 * responses -- a 4xx (bad auth, missing permission, 404) won't succeed on
 * retry, so it's never retried.
 */
async function githubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = getConfig();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API_BASE}${path}`, {
        ...init,
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      lastErr = new Error(`Could not reach ${GITHUB_API_BASE}${path} -- ${describeGithubError(err)}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    }

    const text = await res.text().catch(() => "");
    const isRetryable = res.status === 429 || res.status >= 500;
    lastErr = new Error(`GitHub API returned ${res.status} for ${path}: ${text.slice(0, 300)}`);
    if (isRetryable && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    throw lastErr;
  }

  // Unreachable -- the loop above always either returns or throws -- but
  // keeps tsc happy about every code path returning/throwing.
  throw lastErr;
}

interface RawRef {
  object: { sha: string };
}

/** Returns the commit SHA a branch currently points at, or null if it doesn't exist. */
async function getBranchSha(branch: string): Promise<string | null> {
  const { owner, repo } = getConfig();
  try {
    const ref = await githubFetch<RawRef>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  } catch (err) {
    if (err instanceof Error && /returned 404/.test(err.message)) return null;
    throw err;
  }
}

/**
 * Returns (creating if necessary) a working branch for a sync session,
 * branched off the base branch (GITHUB_DESIGN_SYSTEM_BASE_BRANCH, default
 * "master"). Idempotent: if the branch already exists (a targeted resync
 * reusing an in-progress sync session's branch), just returns its current
 * SHA rather than erroring.
 */
export async function getOrCreateBranch(branchName: string): Promise<string> {
  const { owner, repo, baseBranch } = getConfig();
  const existing = await getBranchSha(branchName);
  if (existing) return existing;

  const baseSha = await getBranchSha(baseBranch);
  if (!baseSha) {
    throw new Error(`Base branch "${baseBranch}" not found on ${owner}/${repo} -- check GITHUB_DESIGN_SYSTEM_BASE_BRANCH.`);
  }
  await githubFetch(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  return baseSha;
}

/** The design-system repo's base branch (what PRs target / what "in the repo" means). */
export function getDesignSystemBaseBranch(): string {
  return getConfig().baseBranch;
}

/** Whether a branch currently exists on the design-system repo. */
export async function branchExists(branch: string): Promise<boolean> {
  return (await getBranchSha(branch)) !== null;
}

/**
 * Every file path present on a branch (recursive tree), or null if the branch
 * doesn't exist. Used to reconcile the DB's "committed" claims against what's
 * actually in the repo -- see reconcile.ts.
 */
export async function listBranchPaths(branch: string): Promise<Set<string> | null> {
  const { owner, repo } = getConfig();
  const sha = await getBranchSha(branch);
  if (!sha) return null;
  const commit = await githubFetch<RawCommit>(`/repos/${owner}/${repo}/git/commits/${sha}`);
  const tree = await githubFetch<{ tree: { path: string; type: string }[] }>(
    `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  return new Set(tree.tree.filter((t) => t.type === "blob").map((t) => t.path));
}

export interface CommitFile {
  path: string;
  /** null deletes this path from the tree (see commitFiles below). */
  content: string | null;
}

interface RawCommit {
  sha: string;
  tree: { sha: string };
}

interface RawBlob {
  sha: string;
}

interface RawTree {
  sha: string;
}

const MAX_COMMIT_ATTEMPTS = 5;

/**
 * Commits one or more files to a branch as a single atomic commit, via the
 * Git Data API (blob -> tree -> commit -> ref update) rather than the
 * simpler one-file-per-commit Contents API -- so a component's TSX +
 * stylesheet + story file (or a whole sync run's token file) land as one
 * clean, reviewable commit instead of several sequential ones.
 *
 * A file with `content: null` is DELETED from the tree instead of written
 * -- the Git Data API supports this by passing `sha: null` for that path
 * in the tree call (no blob needed for a removal). Lets one commit both
 * add/update some paths and remove others, which the "delete a component"
 * flow needs (design-system/components/actions.ts, settings/cleanup-
 * actions.ts) to remove a component's whole file set atomically.
 *
 * A "Generate code" session commits several components CONCURRENTLY to the
 * SAME branch (design-system-codegen-panel.tsx's CONCURRENCY), and git only
 * allows one fast-forward ref update at a time -- two callers that both
 * read the branch's tip before either has updated it will build a tree/
 * commit on the same stale parent, and the second one's ref update is
 * rejected with 422 "Update is not a fast forward" (confirmed against real
 * failures: several components failing this way in the same session, with
 * GitHub's error text verbatim). Blob creation doesn't depend on branch
 * state, so it happens once outside the loop; the tree/commit/ref-update
 * (the part that DOES depend on the branch's current tip) retries against
 * a freshly re-read branch sha on that specific conflict.
 */
export async function commitFiles(branchName: string, message: string, files: CommitFile[]): Promise<string> {
  const { owner, repo } = getConfig();
  if (files.length === 0) {
    throw new Error("commitFiles called with zero files.");
  }

  const blobEntries = await Promise.all(
    files.map(async (file) => {
      if (file.content === null) {
        return { path: file.path, sha: null as string | null };
      }
      const blob = await githubFetch<RawBlob>(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      });
      return { path: file.path, sha: blob.sha as string | null };
    }),
  );

  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const branchSha = await getBranchSha(branchName);
    if (!branchSha) {
      throw new Error(`Branch "${branchName}" doesn't exist -- call getOrCreateBranch first.`);
    }
    const parentCommit = await githubFetch<RawCommit>(`/repos/${owner}/${repo}/git/commits/${branchSha}`);

    const tree = await githubFetch<RawTree>(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: blobEntries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })),
      }),
    });

    const commit = await githubFetch<RawCommit>(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [branchSha] }),
    });

    try {
      await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha }),
      });
      return commit.sha;
    } catch (err) {
      const isFastForwardRace = err instanceof Error && /not a fast forward/i.test(err.message);
      if (!isFastForwardRace || attempt === MAX_COMMIT_ATTEMPTS) throw err;
      // Someone else's commit landed on this branch between our read above
      // and this ref update -- loop around, re-read the (now-moved) branch
      // tip, and rebuild the tree/commit on top of it.
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }

  // Unreachable -- the loop above always either returns or throws on the
  // last attempt -- but keeps tsc happy about every code path returning.
  throw new Error("commitFiles: exhausted retry attempts.");
}

export interface PullRequestInfo {
  number: number;
  htmlUrl: string;
}

interface RawPullRequest {
  number: number;
  html_url: string;
}

/**
 * Opens a PR for the branch if none exists yet, otherwise returns the
 * already-open one -- targeted resyncs (design-system/components/[slug]
 * "Resync this component", settings "Resync tokens") reuse the same PR as
 * an in-progress full sync rather than spawning a new one per click.
 */
export async function openOrUpdatePullRequest(branchName: string, title: string, body: string): Promise<PullRequestInfo> {
  const { owner, repo, baseBranch } = getConfig();

  const existing = await githubFetch<RawPullRequest[]>(
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branchName}`)}&state=open&base=${encodeURIComponent(baseBranch)}`,
  );
  if (existing.length > 0) {
    return { number: existing[0].number, htmlUrl: existing[0].html_url };
  }

  const created = await githubFetch<RawPullRequest>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head: branchName, base: baseBranch, body }),
  });
  return { number: created.number, htmlUrl: created.html_url };
}

/**
 * Merges a PR -- called ONLY when a person explicitly clicks "Confirm &
 * merge" in design-system/settings (see that page's actions.ts). Never
 * called automatically by the sync/codegen flow itself: generated code is
 * real code other UI services install, and until sync quality is proven
 * over time, a human confirms before it reaches the base branch (and,
 * via the design-system repo's own publish-on-push workflow, gets
 * published).
 */
export async function mergePullRequest(prNumber: number): Promise<void> {
  const { owner, repo } = getConfig();
  await githubFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash" }),
  });
}
