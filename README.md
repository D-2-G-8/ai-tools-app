# AI Tools Platform

Scaffold for an AI-tools platform following `PLAN.md` (architecture, data model, infrastructure economics).
Multi-company mode: sign in with Google, create or join a company, and everyone in that company shares its
uploaded documents and project context. At this stage, only `.md` document upload/ingestion is supported.

## What's already built (scaffold v1)

- Next.js App Router + TypeScript + Tailwind
- Drizzle DB schema with pgvector (`src/db/schema.ts`)
- Session-based secret storage — GitLab/LLM tokens are NOT written to the DB (`src/lib/session.ts`)
- Upload `.md` → Vercel Blob → parse headings/frontmatter → chunking → embeddings (Voyage AI) → pgvector
- Settings: GitLab URL/token/project IDs (for AI Review), LLM provider URL/token, per-tool model
- "Prompts" (defaults + custom) and "Stats" (actuals per run + estimate based on pricing) tabs for each tool
- History: unfinished features + run log
- Universal tool runner (prompt + input + optional RAG context → Claude via the Vercel AI SDK)
- **AI Review**: live code review of open GitLab merge requests (`src/lib/code-review/`, `src/lib/gitlab/client.ts`) —
  V1 (single cheap model), V2 (two independent models + a judge that reconciles findings, flagging
  agreed-but-unconfirmed ones as "needs verification" instead of dropping them), V3 (multi-agent — context-aware
  + context-blind "fresh eyes" + security/performance specialists — manual-trigger-only, with a cost estimate
  shown before you run it)
- Registry of 6 tools (`src/lib/tools/registry.ts`) — Business Requirements and AI Review (code review) are fully
  built with their own UI; the rest (System Analysis, Design, Code Generation, Automated Tests) are stubs with
  placeholder prompts, awaiting their own implementation
- **Self-hosted deployment** (Docker + docker-compose, `Dockerfile`/`docker-compose.yml`) as an alternative to
  Vercel — same codebase, chosen via `STORAGE_DRIVER` (S3-compatible storage instead of Vercel Blob) and a
  couple of env vars; see "Self-hosted deployment (Docker)" below
- **Design System**: per-workspace design tokens and components (`design_token`/`design_component` tables),
  synced from a Figma file via OAuth (`src/lib/figma/`) -- each person connects their own Figma account from
  `/design-system/settings`, independent of the Google account used to sign into the app; see "Figma setup"
  below. Sync auto-merges components/sets that share an exact Figma name (never duplicating a variant/state
  across the merge) and flags likely icons (`isLikelyIconName` in `sync.ts` -- "/"-hierarchical names like
  "Outline/Regular/Plus", or a Figma page name containing "icon") into their own dense "Icons" tab instead of
  the Components list. For duplicates sync can't recognize on its own (different literal names, e.g. "Button
  Primary" / "Button Secondary" as separate Figma components instead of variants of one), the Components list
  has a manual "Select to merge duplicates" mode.
- **Design system code sync**: generates real React + CSS Modules components (and a tokens.css) from the
  synced Figma data and opens a pull request in a SEPARATE `design-system` repo other UI services install as
  an npm package -- nothing merges without someone explicitly clicking "Confirm & merge" in Settings; see
  "Design system code sync" below

## Running locally

```bash
pnpm install
cp .env.example .env.local   # and fill in the variables, see below
pnpm db:migrate              # pgvector + migrations + default workspace (idempotent)
pnpm dev
```

You change the schema in `src/db/schema.ts`, then `pnpm db:generate` creates a new migration in
`./drizzle` — which needs to be committed. `pnpm db:migrate` applies any pending migrations
(on Vercel this happens automatically during the `build` step).

Open http://localhost:3000

## Environment variables

See `.env.example`. In short:

| Variable      | Where to get it                                                                                                               | Secret?                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_URL`          | Neon (via Vercel Marketplace or neon.tech directly)                                                                | yes, but this is a platform infrastructure key, not a user token |
| `BLOB_READ_WRITE_TOKEN` | Vercel Dashboard → Storage → Blob                                                                                                   | yes, same as above                                                                                               |
| `SESSION_SECRET`        | `openssl rand -base64 32`                                                                                                           | yes, use a unique one per environment                                               |
| `AUTH_SECRET`           | `openssl rand -base64 32` — see "Authentication setup" below                                                       | yes, use a unique one per environment                                               |
| `AUTH_GOOGLE_ID`        | Google Cloud Console → APIs & Services → Credentials — see "Authentication setup" below                            | no, safe to expose                                                                  |
| `AUTH_GOOGLE_SECRET`    | Google Cloud Console → APIs & Services → Credentials — see "Authentication setup" below                            | yes                                                                                  |
| `ANTHROPIC_API_KEY`     | console.anthropic.com (optional, for personal use without entering a token in the UI) | yes                                                                                                                     |
| `VOYAGE_API_KEY`        | voyageai.com (embeddings, since Claude has no embeddings API of its own)                                              | yes                                                                                                                     |
| `FIGMA_CLIENT_ID`       | Figma → Settings → Apps → your OAuth app -- see "Figma setup" below                                                    | no, safe to expose                                                                                                     |
| `FIGMA_CLIENT_SECRET`   | Same place as above                                                                                                    | yes                                                                                                                     |
| `GITHUB_TOKEN`          | Fine-grained GitHub PAT scoped to the `design-system` repo -- see "Design system code sync" below                     | yes                                                                                                                     |
| `GITHUB_DESIGN_SYSTEM_REPO` | `owner/repo` of the separate design-system repo, e.g. `D-2-G-8/design-system`                                     | no, safe to expose                                                                                                      |
| `GITHUB_DESIGN_SYSTEM_BASE_BRANCH` | Defaults to `master` if unset                                                                                | no, safe to expose                                                                                                      |
| `DESIGN_SYSTEM_STORYBOOK_URL` | URL of the design-system repo's own Storybook deployment -- see "Design system code sync" below              | no, safe to expose                                                                                                      |

The user enters the GitLab token and LLM provider token through the UI (`/settings`) — they are stored only in
an encrypted cookie for the duration of the browser session and are never persisted anywhere.

## Authentication setup

Google sign-in is required for everyone — there's no no-login fallback. One-time setup:

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or reuse) a project, configure the
   OAuth consent screen, and create an **OAuth 2.0 Client ID** of type "Web application".
2. Add authorized redirect URIs: `https://<your-vercel-domain>/api/auth/callback/google` for production, and
   `http://localhost:3000/api/auth/callback/google` for local dev.
3. Set `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` both in Vercel (Project Settings → Environment
   Variables) and in `.env.local` for local dev, then redeploy/restart.
4. **Sign in yourself first**, immediately after this ships. The very first person to ever sign in and create
   a company has the pre-existing default workspace (every document/setting uploaded before auth existed)
   adopted into that company — see `src/app/onboarding/actions.ts`. If someone else signs in and creates a
   company first, they'll end up owning that continuity and you'd have to be invited into your own data.

Company membership is explicit: after signing in, a user either creates a new company (becoming its owner) or
accepts a pending invite for their email address (`/onboarding`). Company owners can invite teammates by email
from `/company` — **no invite email is actually sent** (there's no transactional-email provider in this app),
so the owner needs to tell the invitee out-of-band; the invite auto-activates the next time that address signs
in with Google.

## Figma setup

Optional -- only needed for the Design System's Figma sync (`/design-system/settings`). Unlike Google
sign-in, this is a per-user connection: each person authorizes their own Figma account (whichever login is
convenient for them -- personal, a work seat, whatever), completely independent of the Google account they
signed into the app with. Nobody needs to standardize accounts across systems to use this.

One-time setup, done once by whoever manages this deployment:

1. In [Figma](https://www.figma.com/developers/apps), create a new OAuth app (Settings → Apps) -- if this is
   for one company/team's own files, set the app's **Audience** to "Private" (scoped to your Figma team, no
   Figma review needed); only use "Public" if people outside your team need to connect too, which requires
   Figma's app review.
2. On that app's **OAuth scopes** page (separate from anything set at connect time), enable
   `current_user:read`, `file_content:read`, and `library_content:read`. This is required -- an app with a
   scope requested at connect time but not enabled here fails with `{"error":true,"status":400,"message":
   "Invalid scopes for app"}`. Figma also requires a short description of why each scope is needed when you
   enable it, e.g. "Show which Figma account is connected" for `current_user:read`, and "Read a file's
   published styles/components (and, as a fallback, its full document tree) to sync the design system" for
   `library_content:read`/`file_content:read`.
3. Add redirect URIs: `https://<your-domain>/api/figma/oauth/callback` for production, and
   `http://localhost:3000/api/figma/oauth/callback` for local dev -- both can be registered on the same app.
4. Set `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET` (Vercel Project Settings → Environment Variables, or
   `.env`/`.env.local`), then redeploy/restart.
5. Each person then connects their own account from `/design-system/settings` → "Connect Figma". The
   requested scopes are `current_user:read` (for the "Connected as: ..." display), `library_content:read`
   (the fast path -- `GET /v1/files/:key/{styles,components,component_sets}`, used when the file is published
   as a Figma library) and `file_content:read` (fallback: a full-document-tree read, used only when the file
   isn't published as a library) -- deliberately not `file_variables:read`, since Figma Variables are an
   Enterprise-plan-only API and requesting a scope your plan doesn't support would break the connect flow.

Figma access tokens last 90 days and refresh automatically in the background while connected; if a sync ever
fails with a connection error, just reconnect from Settings. **If you already connected Figma before
`library_content:read` was added to this app's requested scopes, reconnect once** ("Disconnect" then
"Connect Figma" again in Settings) -- an existing session's token was issued under the old, narrower scope
set and won't pick up the new one on its own.

## Design system code sync

Optional -- builds on the Figma sync above. Where Figma sync stores plain metadata (`design_token`/
`design_component`), this generates real React + CSS Modules source code from that metadata and commits it
to a **separate** `design-system` git repo, published as an installable npm package (GitHub Packages) that
other UI services can build on. `ai-tools-app` itself never imports that package directly -- see "Storybook
preview" below for how components are shown here instead.

**How it works:**

1. Settings → "Generate code" (or a single component's "Resync this component", or "Resync tokens" for just
   the token file) generates `tokens.css` deterministically (`src/lib/design-system-codegen/tokens.ts` -- a
   plain serializer, no LLM) and each component's `.tsx`/`.module.css`/`.stories.tsx` via an LLM
   (`src/lib/design-system-codegen/component.ts`) -- a schema-friendly "contract" step (prop names, chosen
   tokens, chosen CSS class names) followed by plain-text generation for the actual source files, all
   grounded in that same contract so the TSX and stylesheet can't disagree on a class name. A deterministic
   (no LLM) check then confirms every class the TSX references is actually defined in the stylesheet before
   anything is committed.
2. Generated files land on a session branch (`figma-sync-<timestamp>`) in the `design-system` repo via the
   GitHub REST API (`src/lib/github/client.ts`), and a pull request is opened. A targeted resync (single
   component or tokens-only) reuses that SAME branch/PR if one is already open, rather than opening a new one
   each time (`src/lib/design-system-codegen/session.ts`).
3. **Nothing merges automatically.** The Settings page shows a "Review & confirm" banner with the PR link
   once one is open -- review its CI status (the `design-system` repo runs its own typecheck/lint/build/
   Storybook-build on the PR, since a 60s serverless function here can't run that toolchain), then click
   "Confirm & merge". This is deliberate: generated code is real code other services install, and until sync
   quality is proven over time, a person confirms before it reaches the base branch (and, via that repo's own
   publish-on-push workflow, gets published as a new package version).

**Storybook preview:** rather than this app installing `@d-2-g-8/design-system` as a live dependency (bundler/
peer-dependency/CSS-Modules edge cases for no real benefit), the component detail page embeds an iframe
pointed at the `design-system` repo's own Storybook (a separate Vercel deployment, `build-storybook` output).
Generated `.stories.tsx` files always define a canonical `Default` story under a `Components/<Name>` title, so
the story id -- and therefore the iframe URL -- is fully derivable from the component's slug
(`storybookDefaultStoryId` in `src/lib/design-system-codegen/component.ts`); no extra DB field needed to track
it.

**Setup, done once by whoever manages this deployment:**

1. Create the `design-system` repo (see that repo's own README for its scaffold/publish setup) in the same
   GitHub org.
2. Create a fine-grained GitHub PAT scoped to ONLY that repo, with **Contents: Read and write** and
   **Pull requests: Read and write**. Set `GITHUB_TOKEN` and `GITHUB_DESIGN_SYSTEM_REPO` (e.g.
   `D-2-G-8/design-system`); `GITHUB_DESIGN_SYSTEM_BASE_BRANCH` only needs setting if that repo's base branch
   isn't `master`.
3. Deploy the `design-system` repo's Storybook as its own separate Vercel project (`build-storybook` /
   `storybook-static` output), then set `DESIGN_SYSTEM_STORYBOOK_URL` here to that deployment's URL (no
   trailing slash). Until this is set, component pages just show a note instead of a live preview -- nothing
   else depends on it.
4. Set a workspace's "Component code stack" in Settings to `react-css-modules` (the only implemented option
   today -- `react-scss` is a selectable-but-unimplemented placeholder, and `none` skips code generation
   entirely).

This is entirely optional -- if `GITHUB_TOKEN`/`GITHUB_DESIGN_SYSTEM_REPO` are unset, the whole feature is
skipped and the Design System pages work exactly as they do with Figma sync alone.

## Deploying to Vercel

1. Push the repository to GitHub/GitLab and import it into Vercel ("Add New Project").
2. Storage → connect **Neon Postgres** (Marketplace) — the `POSTGRES_URL` (or `DATABASE_URL`) variable
   is set automatically.
3. Storage → connect **Blob** — `BLOB_READ_WRITE_TOKEN` is set automatically.
4. Project Settings → Environment Variables: add `SESSION_SECRET`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
   `AUTH_GOOGLE_SECRET` (see "Authentication setup" above), `VOYAGE_API_KEY`, and optionally
   `ANTHROPIC_API_KEY`.
5. Migrations run automatically during the `build` step (`tsx src/db/scripts/migrate.ts && next build`),
   including the pgvector extension and creation of the default workspace — nothing needs to be run by hand.
6. Open the deployed domain, sign in with Google **yourself first** (see "Authentication setup" above), create
   your company, then go to `/settings` → enter your LLM provider token (or set `ANTHROPIC_API_KEY` in the
   environment) and, if needed, the GitLab URL/token.

For a rough infrastructure cost estimate under light single-user load, see `PLAN.md`, section 11
(in short: ~$20/mo baseline + variable LLM-call costs, typically $30–60/mo total).

## Self-hosted deployment (Docker)

An alternative to Vercel for when the app needs native network access to something Vercel's serverless
functions can't reach — for example, a corporate GitLab instance that only resolves on an internal DNS zone
(see AI Review's known limitation below). Same codebase, same features — file storage is the only thing that
changes, since Vercel Blob only exists on Vercel: self-hosted uses S3-compatible storage instead (a bundled
MinIO container by default, or point at real AWS S3), selected via `STORAGE_DRIVER` (see `src/lib/storage/`).

**Prerequisites:**

- Docker and Docker Compose v2.
- A reverse proxy in front of the `app` container doing HTTPS termination (Caddy, nginx, Traefik, your
  corporate load balancer — anything). **This is not optional**: the session cookie that holds the GitLab/LLM
  tokens is marked `secure` (see `src/lib/session.ts`), so sign-in silently fails over plain HTTP. The proxy
  must also set (overwrite, not append) the `X-Forwarded-Proto` and `X-Forwarded-Host` headers to the real
  public values -- the Figma OAuth callback (see "Figma setup" below) derives its redirect URL from these,
  since Next.js doesn't infer the public origin on its own when self-hosted behind a proxy.
- Google OAuth credentials (see "Authentication setup" above — same setup either way, just add the
  self-hosted domain's callback URL too).
- Network reachability from wherever the container runs to anything it needs to reach internally (GitLab,
  etc.) — this is the whole reason to choose this deployment path over Vercel.

**Quick start:**

```bash
cp .env.example .env   # fill in the values -- see the variable reference below
docker compose up -d --build
```

The first boot (and every subsequent restart) automatically applies pending DB migrations before starting the
server (`docker-entrypoint.sh` — idempotent, safe to re-run, same migration script Vercel's build step already
uses). The bundled `minio-init` service creates the storage bucket and makes it public-read on first boot too
— nothing else needs to be run by hand.

**Environment variables (docker-compose-specific, on top of the shared ones in the table above):**

| Variable              | Purpose                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `STORAGE_DRIVER`      | Set to `s3` for self-hosted (unset/`vercel-blob` is the Vercel default) |
| `POSTGRES_USER/PASSWORD/DB` | Credentials for the bundled `postgres` service — `POSTGRES_URL` is built from these automatically |
| `MINIO_ROOT_USER/PASSWORD` | Credentials for the bundled `minio` service (also used as `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`) |
| `MINIO_BUCKET`        | Bucket name, created automatically on first boot                       |
| `S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE` | Only needed if pointing at something other than the bundled MinIO (e.g. real AWS S3 — see note below) |

**Using real AWS S3 instead of the bundled MinIO:** set `STORAGE_DRIVER=s3` and the `S3_*` variables directly
(skip the `minio`/`minio-init` services, or just ignore them). The `minio-init` service's automatic
bucket-creation-and-public-read setup only applies to the bundled MinIO — pointing at real S3 requires
manually creating the bucket and an equivalent public-read bucket policy yourself.

**Updating:** `docker compose build app && docker compose up -d app` — migrations re-run safely on every
start, so there's no separate migration step to remember.

## Known limitations of this version (things to revisit)

- **File upload is synchronous** — ingestion (parsing/chunking/embeddings) runs right inside the Server
  Action immediately after upload. For large batches of documents it should be moved to a background job (Inngest/Trigger.dev,
  see PLAN.md section 2) — for a handful of `.md` files it isn't a problem.
- **Uploads via Server Action** are limited by the standard Vercel Functions request body limit (~4.5 MB).
  For large files, switch to client-side upload (`@vercel/blob` client upload).
  Here we've deliberately restricted uploads to `.md`, for which this isn't a problem in practice.
- **Placeholder substitution in prompts is simplistic** — the runner currently just concatenates the prompt +
  user input + retrieved context, without parsing `{{variables}}` out of the prompt text. A proper
  templating engine is worth building when we work through the individual tools separately (see PLAN.md
  section 8, phase 4).
- **AI Review depends on GitLab being reachable from wherever the app runs.** A self-hosted GitLab instance
  that's only reachable over a VPN or internal network won't be reachable from Vercel's serverless functions —
  the request will simply fail (see `describeGitlabError` in `src/lib/gitlab/client.ts` for the error message
  you'd see). The self-hosted deployment (see above) exists specifically to solve this — run the container
  somewhere with native network access to GitLab instead. Diffs are truncated at ~100K characters (not all
  changes get analyzed on very large MRs), and V3's "full context" is limited to whichever documents you
  explicitly select per review, not auto-detected.
- **No invite emails are sent** — inviting a teammate from `/company` just records the invite; the owner
  has to tell them out-of-band, and the invite only activates once they sign in with Google using that exact
  email address.
- **The pre-auth default workspace is adopted exactly once** — whichever company is created first after this
  shipped keeps all documents/settings that existed before auth; every company created after that starts
  with an empty workspace. See "Authentication setup" above.
- **Presence and edit-locking are best-effort, not real-time push** — "online now" (`/company`, and the
  sidebar's "N online" badge) is based on a `lastSeenAt` timestamp refreshed on page loads and a ~60s
  client-side heartbeat, with a ~3 minute freshness window, so it can lag a little rather than update
  instantly. Document edit locks (`src/db/edit-lock.ts`) work the same way: only one person can have a
  document's edit page open at a time, with a clear "X is currently editing this" message for anyone else who
  tries — the lock is released on save/cancel, or auto-expires ~3 minutes after the last heartbeat if a tab
  crashes or is force-closed, so a document can never get stuck locked forever.
- **Per-user model settings can quietly diverge from what a teammate expects** — each person picks their own
  model per tool in Settings (falling back to whatever the company default happened to be, then to the
  built-in default), so two teammates running the same tool may silently get different models/costs unless
  they compare notes. There's no UI warning about this.
- **Embedded-image captioning is best-effort and uncached** — up to 10 images per document are described
  sequentially by a vision model (`claude-haiku-4-5`) on every ingest (upload, edit-save, or manual
  reprocess), so a document with several images takes noticeably longer to (re)process; a failed/unreachable/
  oversized image is skipped rather than failing the ingest. Image Blobs referenced from a document's markdown
  also aren't tracked anywhere, so deleting a document doesn't clean them up.

## Project structure

```
src/
  auth.ts           Auth.js (NextAuth v5) config -- Google sign-in, Drizzle adapter
  db/               Drizzle schema, DB client, initial setup script
    users.ts        getCurrentUser() -- fresh DB read of the signed-in user's row
    workspace.ts     getCurrentWorkspaceId() -- resolves the signed-in user's company's workspace
    edit-lock.ts     Per-document edit lock (acquire/renew/release, TTL-based expiry)
  lib/
    session.ts      User secrets (cookie, not DB)
    models.ts       Model and pricing catalog
    llm/client.ts   Anthropic client (Vercel AI SDK)
    ingest/         .md parsing/chunking, embeddings, image captioning, ingestion pipeline
    tools/          Tool registry, shared contract, default prompts, per-user model resolution
    presence.ts     "Online now" freshness window + isOnline() helper
    gitlab/client.ts    Plain-fetch GitLab REST v4 client (list MRs, fetch diff, post comment)
    code-review/    AI Review engines -- prompts, v1/v2/v3 review logic, MR-comment formatting
    storage/        File storage driver (Vercel Blob or S3-compatible, picked via STORAGE_DRIVER)
    figma/          Figma OAuth2 (oauth.ts), authenticated REST client (client.ts), and the
                     file-JSON -> design_token/design_component parser (sync.ts) -- also exports
                     resyncComponentFromFigma/resyncTokensFromFigma for targeted resyncs
    github/client.ts    Plain-fetch GitHub REST client (branch/commit/PR/merge) for the design-system
                     code sync -- Git Data API, not the simpler Contents API, for atomic multi-file commits
    design-system-codegen/  tokens.ts (deterministic tokens.css serializer), component.ts (LLM component
                     codegen: contract -> TSX/CSS/stories, deterministic class-name check), data.ts
                     (DB loaders), session.ts (shared code-sync session branch/PR-reuse logic)
  app/
    sign-in/        Google sign-in page
    onboarding/     Create/join a company (after first sign-in)
    api/auth/[...nextauth]/ Auth.js route handler
    api/figma/oauth/{start,callback}/ Figma OAuth2 redirect + callback (route handlers, not Server Actions --
                     these need to issue real redirects to/from www.figma.com)
    api/figma/sync/  SSE live-progress metadata sync (see figma-sync-button.tsx)
    api/design-system/codegen/[slug]/ POST: one component's code generation + GitHub commit, own
                     maxDuration=60 -- kept out of the metadata sync route on purpose, see that route's
                     doc comment
    api/health/     Plain 200, used by the Docker HEALTHCHECK -- see "Self-hosted deployment" above
    (protected)/    Everything below requires a signed-in user in a company -- see layout.tsx
      presence-actions.ts  touchPresence() -- refreshes the signed-in user's lastSeenAt
      company/      Member roster (online/last-seen) + owner-only email invites + company-wide usage
      settings/     Settings -- GitLab/LLM (company-wide), model per tool (personal to you)
      documents/    Document upload/status, and per-document edit locking (see [id]/edit/)
      design-system/ Tokens + components (synced from Figma, see settings/), plus HTML mockups.
                     settings/codegen-actions.ts + design-system-codegen-panel.tsx: full "Generate code"
                     session + "Confirm & merge". components/[slug]/actions.ts +
                     resync-component-button.tsx: "Resync this component" + Storybook preview iframe.
      history/      Unfinished features + run log
      tools/[toolKey]/ Runner, "Prompts" tab, and "Stats" tab per tool -- code-review-actions.ts +
                        code-review-panel.tsx special-case AI Review's own UI instead of the generic runner
```

The full plan and rationale for the architectural decisions is in `PLAN.md`.
