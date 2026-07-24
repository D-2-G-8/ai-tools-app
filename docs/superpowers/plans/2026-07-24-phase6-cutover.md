# Phase 6 Cutover Implementation Plan (surgical DS-tool removal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the design-system tool surface from `ai-tools-app` (it now lives in the separate `design-system` service) WITHOUT breaking the mockup/screen-rebuild feature, which is built on the codegen library.

**Architecture:** Safe order — (1) extract the one shared server action mockups needs out of the DS settings folder, (2) relocate the mockups feature out from under the DS route tree, (3) delete the DS tool surface. Each step is independently buildable; `tsc` + `next build` are the verification (a missed importer of a deleted/moved module fails the build). No DB migration — dead tables/columns are left in place (deferred).

**Tech Stack:** Next.js (a MODIFIED fork — see Global Constraints), pnpm, Drizzle (schema untouched this cutover), TypeScript.

## Global Constraints

- **English only** — code, comments, strings, UI text, commit messages (repo CLAUDE.md).
- **Modified Next.js:** this repo's Next is a fork with breaking changes (repo AGENTS.md). Read `node_modules/next/dist/docs/` before writing any Next API code. The only NEW files here are a plain server-action module and an optional simple layout — no exotic Next APIs.
- **`corepack pnpm`** (bare pnpm is the wrong version). `cd` the repo in every bash call — cwd resets between shells.
- **Verification per task:** `corepack pnpm exec tsc --noEmit` AND `corepack pnpm build` both green. `next build` typechecks stricter and surfaces broken imports to deleted/moved modules.
- **GIT:** `git branch --show-current` guard (`[ "$B" != master ]`) before EVERY commit. Branch: `phase6-cutover` (off master). Never commit to master; never push/merge (the user merges). Quote shell paths containing `()`/`[]` (route groups + dynamic segments): `git mv "src/app/(protected)/design-system/mockups" "src/app/(protected)/mockups"`.
- Commit-message trailers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_015EtzpoR6aBNAHKLcPhAAEP`.
- **This is destructive.** Extract + relocate come BEFORE any delete so mockups never transiently import a moved/deleted path. Never delete a file until its importers are gone or repointed.
- **DO NOT touch** (mockup dependencies / shared infra): the codegen closure (`figma-node`, `component`, `paths`, `tokens`, `dependencies`, `checks`, `review/*`, `data`, `session`, `mockup-sync`, `screen-story`); `figma/client.ts`, `figma/oauth.ts`, `api/figma/oauth/**`; the `design_component` table + shared `workspace` columns; the `"design-system-codegen"` toolKey; `GITHUB_DESIGN_SYSTEM_REPO` / `GITHUB_DESIGN_SYSTEM_BASE_BRANCH` env (mockup rebuild commits via the shared session/PR machinery that reads them); storage / Anthropic / models / db / auth / github client.

---

## File structure

- **NEW** `src/lib/design-system-codegen/session-actions.ts` — the extracted `finishCodeGenSession` shared server action (mockups' only import from the DS settings folder).
- **NEW (optional)** `src/app/(protected)/mockups/layout.tsx` — minimal heading wrapper (replaces the deleted DS layout the mockups pages used to render under).
- **MOVED** `src/app/(protected)/design-system/mockups/**` → `src/app/(protected)/mockups/**`.
- **EDITED** `src/app/(protected)/mockups/actions.ts` (repoint the one relative import); `src/app/(protected)/mockups/[id]/page.tsx` (neutralize dead deep-link); `src/app/(protected)/layout.tsx` (nav); `.env.example`.
- **DELETED** the DS tool surface (routes, pages, settings, DS-only codegen files, figma sync/links) — see Task 3.

---

## Task 1: Extract `finishCodeGenSession` into a shared module

**Files:**
- Create: `src/lib/design-system-codegen/session-actions.ts`
- Modify: `src/app/(protected)/design-system/mockups/actions.ts` (import line only)

**Interfaces:**
- Produces: `export async function finishCodeGenSession(branchName: string): Promise<{ prUrl: string }>` in `@/lib/design-system-codegen/session-actions` — same behavior as the current one in `settings/codegen-actions.ts:156`, minus the `revalidatePath("/design-system/settings")` call (that path is deleted in Task 3; the mockups caller revalidates its own paths).

- [ ] **Step 1: Create the shared module**

`src/lib/design-system-codegen/session-actions.ts`:

```ts
"use server";

import { db } from "@/db";
import { workspace } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentWorkspaceId } from "@/db/workspace";
import { openOrUpdatePullRequest } from "@/lib/github/client";

const PR_TITLE = "Design system: Figma sync";
const PR_BODY =
  "Opened automatically by ai-tools-app's design-system code sync. Review the CI status below, then " +
  'click "Confirm & merge" in Settings once it looks right -- this repo never auto-merges generated code.';

/**
 * Opens (or reuses) the pull request for a session's branch and records the PR
 * url + branch name on the workspace, so a later commit lands on the SAME PR.
 * Never merges. Extracted from the (now-removed) design-system settings so the
 * mockup screen-rebuild flow, which shares the session/PR machinery, keeps working.
 */
export async function finishCodeGenSession(branchName: string): Promise<{ prUrl: string }> {
  const workspaceId = await getCurrentWorkspaceId();
  const pr = await openOrUpdatePullRequest(branchName, PR_TITLE, PR_BODY);

  await db
    .update(workspace)
    .set({ designSystemPendingPrUrl: pr.htmlUrl, designSystemPendingPrBranch: branchName, ciAutofixAttempts: 0 })
    .where(eq(workspace.id, workspaceId));

  return { prUrl: pr.htmlUrl };
}
```

- [ ] **Step 2: Repoint the mockups import**

In `src/app/(protected)/design-system/mockups/actions.ts`, change:

```ts
import { finishCodeGenSession } from "../settings/codegen-actions";
```
to:
```ts
import { finishCodeGenSession } from "@/lib/design-system-codegen/session-actions";
```

(Leave `codegen-actions.ts` itself untouched — it still has its own copy and its other DS-only exports; the whole settings folder is deleted in Task 3.)

- [ ] **Step 3: Verify build**

Run: `cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app && corepack pnpm exec tsc --noEmit && corepack pnpm build`
Expected: both green. Mockups now import `finishCodeGenSession` from the shared module.

- [ ] **Step 4: Commit**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
B=$(git branch --show-current); [ "$B" != master ] && \
git add "src/lib/design-system-codegen/session-actions.ts" "src/app/(protected)/design-system/mockups/actions.ts" && \
git commit -m "refactor: extract finishCodeGenSession into a shared module for mockups

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015EtzpoR6aBNAHKLcPhAAEP"
```

---

## Task 2: Relocate the mockups feature out of the DS tree

**Files:**
- Move: `src/app/(protected)/design-system/mockups/**` → `src/app/(protected)/mockups/**`
- Create: `src/app/(protected)/mockups/layout.tsx`
- Modify: `src/app/(protected)/mockups/[id]/page.tsx` (dead deep-link), `src/app/(protected)/layout.tsx` (nav)

**Interfaces:**
- Produces: the mockups feature served at `/mockups` (was `/design-system/mockups`).

- [ ] **Step 1: Move the directory (preserve history)**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
git mv "src/app/(protected)/design-system/mockups" "src/app/(protected)/mockups"
```

Mockups files import via `@/…` absolute paths (verified) except the one relative import already repointed in Task 1 — so the move needs no further import fixes inside mockups. (If `tsc` in Step 4 reports any remaining relative import that broke, fix it to the `@/…` equivalent.)

- [ ] **Step 2: Add a minimal layout (the old DS layout no longer wraps these)**

`src/app/(protected)/mockups/layout.tsx`:

```tsx
export default function MockupsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Mockups</h1>
        <p className="mt-1 text-neutral-500">
          App screens imported from Figma and rebuilt on the design system.
        </p>
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Neutralize the dead deep-link + fix the nav**

In `src/app/(protected)/mockups/[id]/page.tsx`, the `usesComponents` list links each slug to `/design-system/components/${slug}` (those pages are removed in Task 3). Replace the `<Link href={`/design-system/components/${slug}`}>…</Link>` with the plain slug text (render `{slug}` in a `<span>`), keeping the list itself.

In `src/app/(protected)/layout.tsx`, change the nav entry (line ~27):
```ts
  { href: "/design-system", label: "Design System" },
```
to:
```ts
  { href: "/mockups", label: "Mockups" },
```

- [ ] **Step 4: Verify build + route**

Run: `cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app && corepack pnpm exec tsc --noEmit && corepack pnpm build`
Expected: both green. Confirm the build output lists a `/mockups` route (and `/mockups/[id]` etc.), not `/design-system/mockups`.

- [ ] **Step 5: Commit**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
B=$(git branch --show-current); [ "$B" != master ] && \
git add "src/app/(protected)/mockups" "src/app/(protected)/layout.tsx" && \
git commit -m "refactor: relocate mockups out of the design-system route tree

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015EtzpoR6aBNAHKLcPhAAEP"
```

---

## Task 3: Delete the design-system tool surface

**Files (DELETE):**
- `src/app/api/design-system/` (whole dir: `ci-autofix/`, `visual-review/`, `codegen/`)
- `src/app/api/figma/sync/route.ts`
- `src/app/(protected)/design-system/` (whole dir — mockups already moved out): `page.tsx`, `layout.tsx`, `clear-all-button.tsx`, `components/`, `icons/`, `settings/`
- codegen DS-only files: `src/lib/design-system-codegen/{reconcile,visual-review,visual-diff,ci-autofix,ci-map,icon,icon-fetch,token-derive}.ts`
- `src/lib/figma/sync.ts`, `src/lib/figma/links.ts`
**Files (EDIT):**
- `.env.example`

- [ ] **Step 1: Pre-delete safety grep**

Confirm NONE of the KEPT codegen closure imports a to-be-deleted file (build would catch it, but check first):

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
grep -rnE "design-system-codegen/(reconcile|visual-review|visual-diff|ci-autofix|ci-map|icon|icon-fetch|token-derive)|figma/sync|figma/links" src/lib/design-system-codegen "src/app/(protected)/mockups" | grep -v -E "/(reconcile|visual-review|visual-diff|ci-autofix|ci-map|icon|icon-fetch|token-derive)\.ts:|figma/sync\.ts:|figma/links\.ts:"
```
Expected: NO output (nothing kept imports a deleted module). If any line appears, STOP and report — a kept file depends on a deletion target and the plan needs revisiting.

- [ ] **Step 2: Delete the tool surface**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
git rm -r "src/app/api/design-system"
git rm "src/app/api/figma/sync/route.ts"
git rm -r "src/app/(protected)/design-system"
git rm src/lib/design-system-codegen/reconcile.ts src/lib/design-system-codegen/visual-review.ts \
       src/lib/design-system-codegen/visual-diff.ts src/lib/design-system-codegen/ci-autofix.ts \
       src/lib/design-system-codegen/ci-map.ts src/lib/design-system-codegen/icon.ts \
       src/lib/design-system-codegen/icon-fetch.ts src/lib/design-system-codegen/token-derive.ts
git rm src/lib/figma/sync.ts src/lib/figma/links.ts
```

- [ ] **Step 3: Trim `.env.example`**

Remove ONLY the storybook lines (`DESIGN_SYSTEM_STORYBOOK_URL`, `DESIGN_SYSTEM_STORYBOOK_URL_TEMPLATE`). **KEEP** `GITHUB_DESIGN_SYSTEM_REPO` and `GITHUB_DESIGN_SYSTEM_BASE_BRANCH` — mockup rebuild commits generated screens via the shared session/PR machinery (`getOrOpenSessionBranch` → `session.ts`), which reads them.

- [ ] **Step 4: Verify — build is the gate**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
corepack pnpm exec tsc --noEmit && corepack pnpm build
```
Expected: both green. A green build proves nothing kept imports anything deleted. Then confirm no dangling references remain:
```bash
grep -rnE "api/design-system|design-system/(components|icons|settings)|figma/sync|figma/links|design-system-codegen/(reconcile|visual-review|visual-diff|ci-autofix|ci-map|icon|icon-fetch|token-derive)" src | grep -v node_modules
```
Expected: NO output (all references gone).

- [ ] **Step 5: Commit**

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
B=$(git branch --show-current); [ "$B" != master ] && \
git add .env.example && \
git commit -m "chore: remove the design-system tool (now a standalone service)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015EtzpoR6aBNAHKLcPhAAEP"
```

---

## Final verification (after all tasks)

```bash
cd /Users/dariagritsienko/Desktop/daily-prep-anthropic/ai-tools-app
corepack pnpm exec tsc --noEmit
corepack pnpm build
# mockups feature intact + served at /mockups:
grep -rn "/mockups" "src/app/(protected)/layout.tsx"
ls "src/app/(protected)/mockups"
# nothing dangling:
grep -rnE "api/design-system|/design-system/(components|icons|settings|mockups)|figma/sync|figma/links" src | grep -v node_modules || echo "clean"
```
All green + "clean" = the DS tool is gone, mockups intact. Hand off for the user to merge.

## Deferred follow-ups (NOT this plan — documented in the spec)
- DB drops (`design_token`, DS-only `design_component` columns, `workspace.ciAutofixAttempts`) — destructive migration, deferred.
- Rename `src/lib/design-system-codegen/` (now a mockup dependency) — churn, deferred.
- Refresh the stale monorepo README — lives in the **`design-system` repo**, separate task.

## Self-review notes (traceability)
- Spec DELETE set → Task 3. Spec KEEP/RELOCATE → Tasks 1 (extract) + 2 (relocate). Spec order (extract → relocate → delete) → Task order 1→2→3, each build-gated.
- The one mockups→settings coupling (`finishCodeGenSession`) is severed in Task 1 BEFORE the settings folder is deleted in Task 3 — no transient broken import.
- Mockups moved out (Task 2) BEFORE the DS dir is deleted (Task 3) — the `git rm -r design-system` in Task 3 can't hit mockups.
- GitHub-repo envs KEPT (Task 3 Step 3) per the Risks section — mockup rebuild needs them.
- No DB migration anywhere — matches the spec's deferral.
