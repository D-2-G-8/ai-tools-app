# Phase 6 — Cutover: retire the design-system tool from `ai-tools-app` (surgical)

## Context
The design-system codegen tool was extracted into a standalone service (the
`design-system/` monorepo: `apps/admin` + `packages/codegen` + GitHub-Actions
workers). Its **duplicate** still lives in this monolith (`ai-tools-app`). Phase 6
retires that duplicate. Precondition (a real end-to-end run on the live Figma
library) is **MET**.

**Key constraint discovered during mapping:** the **mockup / screen-rebuild**
feature (which we KEEP) is built ON the design-system codegen library — it is
physically nested under `app/(protected)/design-system/mockups/**` and
transitively imports most of `src/lib/design-system-codegen/**`
(`figma-node`, `component`, `paths`, `tokens`, `dependencies`, `checks`,
`review/*`, `data`, `session`) plus `finishCodeGenSession` from the DS settings
folder, and it shares the `design_component` table, several `workspace` columns,
the `"design-system-codegen"` toolKey, the GitHub session/PR machinery, and the
Figma client/OAuth.

**Therefore the codegen library cannot be fully deleted while mockups stays.**
Scope chosen with the user: **surgical** — remove the design-system *tool surface*
(UI, API routes, Figma sync, DS-only codegen files, DS nav); keep the codegen
library + shared DB as private mockup dependencies. Full de-duplication (decoupling
mockups from the codegen closure) is explicitly out of scope.

## Goal
Remove the visible design-system tool from the platform without breaking the
mockup feature, in a safe order (decouple shared code → relocate the kept feature
→ delete the tool surface → verify).

## Scope

### DELETE (design-system tool surface — nothing kept imports these)
- **API routes:** `src/app/api/design-system/**` (`ci-autofix/route.ts`,
  `visual-review/[slug]/route.ts`, `codegen/[slug]/route.ts`), and
  `src/app/api/figma/sync/route.ts`.
- **DS pages/UI:** under `src/app/(protected)/design-system/`: `page.tsx` (Tokens),
  `clear-all-button.tsx`, `components/**`, `icons/**`, and `settings/**` — INCLUDING
  `settings/codegen-actions.ts`, but only AFTER step 1 has moved its shared
  `finishCodeGenSession` out (once extracted, the file's remaining exports are all
  DS-only). The DS `layout.tsx` (sub-nav) is deleted once mockups relocate out.
- **DS-only codegen files** in `src/lib/design-system-codegen/`: `reconcile.ts`,
  `visual-review.ts`, `visual-diff.ts`, `ci-autofix.ts`, `ci-map.ts`, `icon.ts`,
  `icon-fetch.ts`, `token-derive.ts`.
- **Figma DS-only:** `src/lib/figma/sync.ts`, `src/lib/figma/links.ts`.
- **Nav:** the `/design-system` entry in `src/app/(protected)/layout.tsx` (repoint
  to `/mockups`).
- **Env (`.env.example`):** `GITHUB_DESIGN_SYSTEM_REPO`,
  `GITHUB_DESIGN_SYSTEM_BASE_BRANCH`*, `DESIGN_SYSTEM_STORYBOOK_URL`,
  `DESIGN_SYSTEM_STORYBOOK_URL_TEMPLATE`. *KEEP the two GitHub-repo envs IF mockup
  rebuild still commits generated screens to the design-system repo (verify during
  implementation — see Risks).

### KEEP / RELOCATE (mockups + shared platform)
- **Relocate** `src/app/(protected)/design-system/mockups/**` →
  `src/app/(protected)/mockups/**` (out from under the deleted tree). Fix its route
  paths (`[id]/render/route.ts`, `[id]/download/route.ts`), the nav link, and
  **neutralize deep-links** to deleted DS pages (`mockups/[id]/page.tsx` links to
  `/design-system/components/<slug>` — remove or render as plain text).
- **Extract** `finishCodeGenSession` (and its `startCodeGenSession` /
  `getOrOpenSessionBranch` dependencies) out of `settings/codegen-actions.ts` into
  a shared module (e.g. `src/lib/design-system-codegen/session-actions.ts`) so
  deleting the settings folder doesn't break mockups.
- **KEEP untouched (mockup dependencies / shared infra):** the codegen closure
  (`figma-node`, `component`, `paths`, `tokens`, `dependencies`, `checks`,
  `review/*`, `data`, `session`, `mockup-sync`, `screen-story`); `figma/client.ts`,
  `figma/oauth.ts`, `api/figma/oauth/**`; `design_component` table + the shared
  `workspace` columns (`figmaFileKey`, `designComponentStack`,
  `designSystemPendingPrUrl`, `designSystemPendingPrBranch`); the
  `"design-system-codegen"` toolKey + `run` rows; storage, Anthropic client,
  models, db, auth/session, github client.

### DEFERRED (documented follow-ups, NOT this cutover)
- **DB drops:** dropping `design_token`, `workspace.ciAutofixAttempts`, and the
  DS-only `design_component` columns (`contractJson`, `lastCodeSyncAt`,
  `lastCodeCommitSha`, `codeSyncStatus`) is a destructive migration and risky
  (mockup rebuild loads tokens via `component.ts`). Dead tables/columns are
  harmless; leave them. Drop later if wanted.
- **Rename** `src/lib/design-system-codegen/` (now a mockup dependency, misnomer) —
  churn/risk; leave as-is.
- **README refresh:** the stale root README lives in the **`design-system` repo**,
  not `ai-tools-app` — separate small task on a design-system branch.

## Approach / order (safe sequencing)
1. **Extract shared** `finishCodeGenSession` → new shared module; repoint mockups'
   import. Verify build. (Nothing deleted yet.)
2. **Relocate mockups** out of the DS tree; fix routes, nav link, neutralize
   dead deep-links. Verify `/mockups` routes resolve + build.
3. **Delete the tool surface** (API routes, DS pages, DS settings, DS-only codegen
   files, `figma/sync`+`links`, nav entry, DS-only env). Verify build.
4. **Final verify:** `tsc --noEmit` + `next build` green; mockups pages/actions
   still compile and resolve; no dangling imports of deleted modules.

Each step is independently buildable — do them as separate commits so a break is
localized. TypeScript + `next build` are the truth: a missed importer of a deleted
module fails the build.

## Testing / verification
- After EACH step: `corepack pnpm exec tsc --noEmit` (or the repo's `typecheck`)
  and `corepack pnpm build` both green. `next build` typechecks stricter and will
  surface any broken import to a deleted/moved module.
- Grep after deletion: no remaining import of any deleted module path
  (`design-system-codegen/(reconcile|visual-review|visual-diff|ci-autofix|ci-map|icon|icon-fetch|token-derive)`,
  `figma/sync`, `figma/links`, `api/design-system`).
- Manual: the mockups list, a mockup detail page, sync-from-figma, and
  rebuild-screen still render/compile (the KEEP feature is intact).

## Risks & mitigations
- **Mockups breakage (primary risk):** every deletion step is build-gated; the
  extract + relocate steps come FIRST so mockups never transiently import a deleted
  path. `next build` catches any missed importer.
- **GitHub-repo envs:** mockup rebuild commits generated screens via the shared
  session/PR machinery. Before deleting `GITHUB_DESIGN_SYSTEM_REPO` /
  `_BASE_BRANCH`, confirm whether mockup rebuild still targets the design-system
  repo; if so, KEEP them. Verify by tracing `session-actions`/`github/client` at
  implementation time.
- **`design_component` table:** DS-only by origin but read by mockup rebuild's
  component index — NOT dropped (see Deferred). Leaving it is correct, not debt to
  fix now.
- **Route-path change** (`/design-system/mockups/*` → `/mockups/*`): update the nav
  link and any internal `href`s; old deep-links from mockups into DS component
  pages are removed (those pages no longer exist).
- **Destructive + first real write to `ai-tools-app`:** work on a feature branch;
  per-step commits; the user merges. No DB migration in this cutover.

## Non-goals
- No decoupling of mockups from the codegen library (full de-dup) — surgical only.
- No DB schema drops / migrations.
- No rename of the `design-system-codegen` lib dir.
- README refresh is a separate design-system-repo task.

## Verify (done-when)
`tsc --noEmit` + `next build` green on `ai-tools-app` with the DS tool surface gone;
grep shows zero imports of deleted modules; the mockups feature (list, detail,
sync-from-figma, rebuild-screen) compiles and its routes resolve under `/mockups`.
