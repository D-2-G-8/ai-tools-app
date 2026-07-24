# Multi-tenant credential model — design (Figma-first)

> Realizes the AI Tools platform's per-user / per-tenant credential principle
> (see `docs/platform-architecture.md` §2.7 guardrails & permissions, and the
> per-user-credentials direction). Scope: **Figma-first** as the proving ground —
> the abstraction is general (GitHub, Anthropic follow the same pattern later),
> but only Figma is carried end-to-end here.

## Problem
Today the platform and the design-system service resolve external tokens from a
single shared owner env var (`FIGMA_ACCESS_TOKEN`, `GITHUB_TOKEN`, …). That is a
dead end for a platform meant to be shared to many companies (SaaS, self-host,
subscription): the owner's personal key must never be the token other tenants'
usage runs on. Every credential read is also scattered (many `process.env.*`
sites), so there is no seam to change resolution behind.

## Locked decisions (from brainstorming)
- **Deployment: hybrid** — both a shared multi-tenant SaaS AND self-host /
  deploy-per-tenant. One abstraction must serve both.
- **Scope: Figma-first** — general `CredentialProvider`, Figma carried end-to-end.
- **SaaS at-rest encryption: envelope + cloud KMS** (per-secret data key, wrapped
  by a KMS master key; rotation + audit).
- **Headless worker token delivery: repo-per-tenant** — each tenant's
  design-system service is its OWN repo with its OWN Actions secrets, so the
  headless worker always uses its own repo's token. **No token broker, no secret
  in `workflow_dispatch` inputs.**

## Core abstraction — the `CredentialProvider` seam
Every token read goes through ONE resolver, replacing all scattered `process.env`
reads:

```ts
type Integration = "figma" | "github" | "anthropic";           // figma carried E2E now
type ExecContext = "interactive" | "headless";                  // user present? or worker?

interface CredentialContext {
  integration: Integration;
  exec: ExecContext;
  tenantId: string;              // the workspace/company
  userId?: string;               // required when exec === "interactive" (per-user creds)
}

interface CredentialProvider {
  // Returns a usable token (already refreshed if needed) or null if not connected.
  resolve(ctx: CredentialContext): Promise<string | null>;
}
```

Two implementations behind the same interface, chosen once at boot by deployment mode:

- **`EnvCredentialProvider` (self-host / deploy-per-tenant, and dev):** reads from
  env/deployment config. `tenantId`/`userId` are effectively singular. This is
  today's behavior, just wrapped — so wrapping is a **zero-behavior-change** first
  step.
- **`StoreCredentialProvider` (shared SaaS):** reads per-user OAuth tokens and
  per-tenant service config from the encrypted store (below).

## Credential taxonomy — three categories, resolved differently
1. **Per-user identity** (interactive only): **Figma OAuth**, GitHub-as-user. A
   real human authenticates; the token is theirs. Resolved from the per-user OAuth
   store (SaaS) or the env PAT fallback (self-host/dev). Used in request context
   with a `userId`.
2. **Per-tenant service** (headless): the worker's Figma sync token, the
   PR-create GitHub token, the Anthropic key. Resolved from the tenant's own
   deployment — **its repo's Actions secrets** (repo-per-tenant). Not tied to any
   one human.
3. **Platform infra** (always platform env): `AUTH_SECRET`, the OAuth app
   client-id/secret, the KMS master-key reference. Never per-tenant, never in the
   store.

## Deployment modes behind the seam
- **Self-host / deploy-per-tenant:** one tenant per deployment. `EnvCredentialProvider`
  everywhere. Per-user "identity" creds may still be per-user (OAuth into that
  single tenant), but the worker just uses the deployment's env/repo secret. The
  "repo-per-tenant" worker model IS this mode for the headless side.
- **Shared SaaS:** many tenants, one app + DB. `StoreCredentialProvider` for
  interactive per-user creds (encrypted per-user OAuth tokens). Headless workers
  are STILL repo-per-tenant (each SaaS tenant gets a provisioned design-system
  repo), so the worker side never needs the shared store or a broker.

## Storage — per-user OAuth store (SaaS interactive only)
- A `user_credential` table: `(userId, tenantId, integration, ciphertext,
  dataKeyWrapped, tokenExpiresAt, refreshCiphertext?, meta)`. One row per
  (user, integration).
- **Envelope encryption:** generate a random data key per secret; encrypt the
  token with it (AEAD, e.g. AES-256-GCM / libsodium secretbox); wrap the data key
  with a **cloud KMS** master key; store `ciphertext` + `dataKeyWrapped`. Decrypt =
  KMS-unwrap the data key, then AEAD-open. KMS master key never leaves KMS; rotation
  = re-wrap data keys; every unwrap is auditable in KMS logs.
- Refresh tokens stored the same way; the provider refreshes transparently on
  resolve when near expiry (mirrors the existing `getValidFigmaAccessToken` skew
  logic).
- **Self-host** skips this table entirely (env provider).

## Headless worker — repo-per-tenant (the simplification)
Because each tenant's design-system service is its own repo with its own Actions
secrets:
- The codegen worker (`sync`/`generate`/`visual`) reads `FIGMA_ACCESS_TOKEN` (and
  `CREATE_PR_TOKEN`, `ANTHROPIC_API_KEY`) from **its own repo's secrets** = that
  tenant's service tokens, provisioned when the tenant's repo is set up.
- **No token broker, no runtime pull, no secret in `workflow_dispatch` inputs**
  (which GitHub logs). The worker never touches another tenant's credentials
  because it only exists in that tenant's repo.
- The platform admin that dispatches the worker still passes only `{slug, jobId}` —
  never a token.
- Trade-off (accepted): provisioning a repo + its secrets per SaaS tenant is real
  infra work at scale; recorded as a provisioning concern, not a security hole.

## Figma carried end-to-end (the proving ground)
Three Figma token sites today, mapped onto the model:
1. **Platform mockups** (`ai-tools-app`, interactive) — ALREADY per-user OAuth
   (Figma connect in `/settings`; `getValidFigmaAccessToken` prefers the session
   token, env PAT is dev/CLI fallback). Rewire its read through the provider
   (`exec:"interactive"`, `integration:"figma"`, userId from session).
2. **design-system admin review render** (interactive) — currently owner env PAT
   (`review/[slug]/page.tsx`). Add a Figma OAuth provider to the admin's NextAuth,
   persist the token per-user, resolve via the provider. **Compat risk:** admin is
   Next 16 / React 19 / `next-auth@5.0.0-beta.32` — multi-provider + token
   persistence untested on that combo; the plan must verify (or hand-roll the OAuth
   like the documented contingency) before committing.
3. **design-system codegen worker** (headless) — repo-per-tenant: its own repo
   secret. Resolve via `EnvCredentialProvider` (`exec:"headless"`). No change in
   single-tenant today; correct per-tenant at scale.

## Migration path (incremental, low-risk)
1. Introduce `CredentialProvider` + `EnvCredentialProvider`; route ALL current
   `process.env.FIGMA_ACCESS_TOKEN` reads through it. **Zero behavior change** —
   pure indirection. Verify build/tests both repos.
2. Add the Figma OAuth per-user path in the two interactive sites via the provider
   (platform mockups already has it; wire admin render).
3. Add `StoreCredentialProvider` + the `user_credential` table + envelope/KMS for
   SaaS. Gated by deployment mode; self-host untouched.
4. GitHub + Anthropic follow the same three-step pattern later (out of scope here).

## Security
- KMS master key in KMS only; data keys wrapped, never stored plaintext; AEAD for
  token ciphertext. Rotation = re-wrap.
- No secret ever enters a `workflow_dispatch` input, a log line, or a client
  bundle. The worker's tokens are repo Actions secrets (GitHub-encrypted).
- **Flag (pre-existing, fix separately):** `design-system/.env.local` holds live
  cleartext secrets (`GITHUB_TOKEN` PAT, `AUTH_SECRET`, `ADMIN_TOKEN`) — rotate +
  ensure gitignored; not part of this design but noted.

## Non-goals
- Not GitHub/Anthropic end-to-end (same pattern, later).
- Not the broader multi-tenant workspace/routing/billing model — only the
  credential-resolution seam.
- Not a runtime token-broker for headless workers — repo-per-tenant removes the
  need.
- Not changing self-host behavior — the env provider preserves it exactly.

## Verify (done-when)
- Every Figma token read in both repos goes through `CredentialProvider`; grep
  finds no direct `process.env.FIGMA_ACCESS_TOKEN` outside `EnvCredentialProvider`.
- Self-host mode: behavior identical to today (env provider), builds/tests green.
- Interactive sites resolve a per-user Figma OAuth token when connected, env PAT
  only as the documented fallback.
- The headless worker uses its own repo secret; no token in any dispatch input or
  log.
