# AI Tools Platform

Scaffold for an AI-tools platform following `PLAN.md` (architecture, data model, infrastructure economics).
Multi-company mode: sign in with Google, create or join a company, and everyone in that company shares its
uploaded documents and project context. At this stage, only `.md` document upload/ingestion is supported.

## What's already built (scaffold v1)

- Next.js App Router + TypeScript + Tailwind
- Drizzle DB schema with pgvector (`src/db/schema.ts`)
- Session-based secret storage — GitLab/LLM tokens are NOT written to the DB (`src/lib/session.ts`)
- Upload `.md` → Vercel Blob → parse headings/frontmatter → chunking → embeddings (Voyage AI) → pgvector
- Settings: GitLab URL/token, LLM provider URL/token, per-tool model
- "Prompts" (defaults + custom) and "Stats" (actuals per run + estimate based on pricing) tabs for each tool
- History: unfinished features + run log
- Universal tool runner (prompt + input + optional RAG context → Claude via the Vercel AI SDK)
- Registry of 6 tools (`src/lib/tools/registry.ts`) — prompts are still stubbed for all but code review and business requirements

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
- **The code-review tool is a stub.** The registry (`src/lib/tools/registry.ts`) reserves a slot for it;
  the actual integration of the existing tool is the next step after the scaffold.
- **No invite emails are sent** — inviting a teammate from `/company` just records the invite; the owner
  has to tell them out-of-band, and the invite only activates once they sign in with Google using that exact
  email address.
- **The pre-auth default workspace is adopted exactly once** — whichever company is created first after this
  shipped keeps all documents/settings that existed before auth; every company created after that starts
  with an empty workspace. See "Authentication setup" above.
- **No presence or edit-locking yet** — `/company` shows a static member roster (who's in the company, and
  each document's creator/last editor), not who's online right now, and two people can still overwrite each
  other's edits to the same document. Planned as a later phase.
- **Per-user model settings and usage stats are not split out yet** — `/settings` and the per-tool "Stats" tab
  are still workspace-wide (i.e. company-wide), not per-user. Planned as a later phase.
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
  lib/
    session.ts      User secrets (cookie, not DB)
    models.ts       Model and pricing catalog
    llm/client.ts   Anthropic client (Vercel AI SDK)
    ingest/         .md parsing/chunking, embeddings, image captioning, ingestion pipeline
    tools/          Tool registry, shared contract, default prompts
  app/
    sign-in/        Google sign-in page
    onboarding/     Create/join a company (after first sign-in)
    api/auth/[...nextauth]/ Auth.js route handler
    (protected)/    Everything below requires a signed-in user in a company -- see layout.tsx
      company/      Member roster + owner-only email invites
      settings/     Settings (GitLab/LLM, per-tool models)
      documents/    Document upload and status
      history/      Unfinished features + run log
      tools/[toolKey]/ Runner, "Prompts" and "Stats" tabs per tool
```

The full plan and rationale for the architectural decisions is in `PLAN.md`.
