# AI Tools Platform — Architecture (reference)

> Status: reference / living document. Date: 2026-07-24.
> This is the target architecture that **all subsequent features layer onto**.
> **This repo (`ai-tools-app`) is the platform spine.** The first extracted
> service lives in a separate repo, **`design-system/`** (the pilot).

## 1. Purpose & how to use this doc

The AI Tools platform is a collection of LLM-powered "tools" (design-system
codegen, mockup rebuild, and more to come). As tools mature they graduate from
living inside this serverless monolith (`ai-tools-app`) into **standalone
services** with their own toolchain and guardrails. The **design-system service**
(`design-system/` monorepo) is the first such extraction and the reference every
later service copies.

Every agent-shaped feature must reason about ten cross-cutting aspects. This doc:

- **§2** defines those ten aspects and records **where each already lives** and
  **what the design-system service already proved** — so a new feature reuses a
  known-good pattern instead of reinventing it.
- **§3** defines the **topology**: a thin platform *spine* plus *services*.
- **§4** defines the **service-extraction pattern** — how a monolith tool becomes
  a service, and the criteria for when that's worth it.
- **§5** names and prioritizes the **three real platform gaps** (semantic memory,
  eval program, distributed tracing) as future work.
- **§6** frames **Phase 6 cutover** (retire the old design-system tool from this
  repo) — rationale, scope, safety. It gets its own spec/plan when executed.
- **§7** distills the **invariants** every future feature must respect.

**How to use it:** before designing a feature, read §2 for the aspect(s) it
touches and reuse the existing pattern; check §7 for the invariants; if the
feature is big enough to be its own tool, read §4.

---

## 2. The ten aspects

For each: a one-line definition, the **current state** (concrete module/workflow,
emphasizing what the design-system service proved), and **where it belongs**
(service, spine, or both).

### 2.1 Harness engineering
*The execution substrate an agent runs in — the surfaces it can touch, the ones
it can't, and how work is dispatched and observed.*

- **Current (DS service):** the worker is a **GitHub Actions workflow**
  (`generate.yml`, `sync.yml`, `baseline.yml`, `delete.yml`) running a real
  toolchain (Node/git/Chromium/pnpm/tsc/Playwright). The admin UI (`apps/admin`,
  Next.js on Vercel) is UI/API-only; it `workflow_dispatch`es the worker and
  polls the run. Locked vs editable surfaces: generated code lands in a **PR**, a
  **human merges**; nothing auto-merges.
- **Current (spine, `ai-tools-app`):** serverless Next.js routes on Vercel — the
  constraint that motivated moving the real-toolchain work out (§4).
- **Belongs:** each service owns its worker harness. The spine owns dispatch/auth.

### 2.2 Loop engineering
*Bounded iterate-until-good loops with a cost ceiling and human escalation.*

- **Current (DS service):** the `generate → tsc/gate → holisticFix` loop
  (`runValidationLoop`, bounded rounds + a paid-LLM cap); the CI-typecheck
  feedback autofix loop; the visual-review loop. Every loop is capped and
  degrades to "needs human," never spins unbounded.
- **Belongs:** a reusable "bounded loop with escalation" shape; each service
  parameterizes it.

### 2.3 Context engineering
*Getting the right, compact information in front of the model — and keeping
durable state out of the prompt.*

- **Current (DS service):** the **distiller** (`figma-node.ts`) compacts a
  ~52 MB Figma subtree into a small text spec; **contracts** are persisted as
  files and fed back as composition grounding; token var-names and child-contract
  APIs ground generation. **State = git files** (manifest, contracts, tokens) —
  the filesystem is the durable context, not a prompt.
- **Current (spine):** `ai-tools-app` also uses Voyage embeddings for its mockup
  retrieval — a per-tool context source, not a shared memory (see §2.5 / §5.1).
- **Belongs:** the state-as-files discipline is a spine-wide principle (§7); the
  per-domain distiller is service-owned.

### 2.4 Tool design
*The tools an agent (or an operator) calls: names, schemas, structured outputs,
actionable errors.*

- **Current (DS service):** the **codegen CLI** (`sync`/`generate`/`delete`/
  `visual`/`doctor`) — deterministic where it can be, structured output
  (`<slug>.contract.json`), errors that name the fix.
- **Belongs:** service-owned; the spine keeps a catalog of tools/services.

### 2.5 Memory architecture
*What the system remembers across runs and sessions, and how it's retrieved.*

- **Current (DS service):** **state-as-git-files** — durable, diffable,
  reconcilable, human-reviewable. This is *working state*, not *semantic memory*.
- **Current (spine):** per-tool DB state (Postgres/Neon) + Voyage embeddings for
  mockup retrieval — tool-local, not a cross-session/cross-tool memory.
- **Gap (spine):** there is **no cross-session semantic memory** (embeddings /
  entity tracking / temporal validity) shared across tools. See §5.1.

### 2.6 Orchestration patterns
*Coordinating multiple units of work — ordering, fan-out, skip/block.*

- **Current (DS service):** **dependency-level** orchestration (`topoLevels`,
  leaves-first so composed children commit before dependents), skip-committed /
  block-dependents-of-failures, admin batch dispatch.
- **Gap (spine):** no orchestration *across services*. See §5 (lower priority).

### 2.7 Guardrails & permissions
*What the system is allowed to do, and the gates that enforce it.*

- **Current (DS service):** deterministic gates **A1–A7** (build-safety,
  prop-value/composition-type membership) run **before** any LLM spend;
  **merge-gating** on GitHub `mergeable_state` + CI summary; **GitHub OAuth**
  login; a **bearer-gated** usage endpoint; **never-auto-merge**;
  **422-on-broken-build** (never commit a broken build); reconcile **never
  auto-deletes committed code** (only never-generated seeds).
- **Current (spine):** per-user Figma OAuth, session auth, workspace-scoped
  lookups (IDOR-guarded).
- **Belongs:** each service owns its domain gates; the spine owns auth + a unified
  permission model (partially present — see §5).

### 2.8 Evals for agents
*Measuring whether an agent's output is actually good, deterministically where
possible and by judgment where not.*

- **Current (DS service):** three eval contours — **deterministic checks** (gates),
  **LLM DoD/AC review** (fidelity + behavior rubric), and **visual vision-diff**;
  plus committed `node:test` fixtures (74 in codegen, 35 in admin).
- **Gap (spine):** no **eval *program*** — no regression scoring across runs, no
  aggregate quality dashboard, no golden-set gating. See §5.2.

### 2.9 Human-in-the-loop design
*Where a person reviews, approves, or corrects, and how the UI makes that fast.*

- **Current (DS service):** the **admin review surface** — dashboard status,
  `/review/<slug>` (design-vs-rendered plates, OverlayCompare onion-skin, worker
  findings, **gated merge**), baseline/delete controls, "Figma changed" staleness
  badge/notice. Destructive/outward actions are always human-gated.
- **Belongs:** service-owned surface; the spine could later provide a shared
  review-surface component library.

### 2.10 Observability & tracing
*Seeing what happened inside a run, and correlating it end-to-end.*

- **Current (DS service):** job rows (`JobsPanel`), per-job token/cost history,
  worker result files, CI annotations, server-action error surfacing.
- **Gap (spine):** no **distributed tracing** across the whole loop (dispatch →
  worker → LLM calls → PR → merge) and no structured-log correlation across
  services. See §5.3.

---

## 3. Topology: a thin spine + services

```
                ┌─────────────────────────────────────────┐
                │      PLATFORM SPINE (this repo,           │
                │            ai-tools-app)                  │
                │  auth · tool/service catalog · dispatch   │
                │  hosts un-extracted tools (mockups, …)    │
                │  [future spine: semantic memory, eval     │
                │   program, distributed tracing]           │
                └───────────────┬───────────────┬───────────┘
                                │                │
              ┌─────────────────▼──┐      ┌──────▼───────────────┐
              │  design-system svc │      │  (future services,   │
              │  (PILOT — separate │      │   extracted per §4)  │
              │   repo/monorepo)   │      │                      │
              │  admin + codegen + │      │  monolith tools stay │
              │  GH-Actions workers│      │  here until worth    │
              └────────────────────┘      │  moving              │
                                          └──────────────────────┘
```

- **Spine = `ai-tools-app` (this repo).** Owns cross-cutting concerns:
  authentication, the tool/service catalog and dispatch, and (future) the three
  shared capabilities in §5. It also still *hosts* the tools that haven't been
  extracted yet (mockup rebuild, etc.).
- **Services** are extracted tools with a bounded domain and their own toolchain,
  living in their own repos. **design-system is the pilot and the only service
  today.** Everything else stays in the monolith until §4's criteria say
  extraction pays off (**YAGNI**: do not mass-extract).
- The design-system service is the **reference implementation** — it already
  demonstrates 8 of the 10 aspects (§2); new services copy its shape.

---

## 4. The service-extraction pattern

**When to extract a monolith tool into a standalone service** — extract when the
tool hits *any* of:

- It needs a **real toolchain** the serverless host can't give it (design-system
  needs Node/git/Chromium/Playwright — the trigger that justified its extraction).
- Its **state is drifting** in the DB and would be cleaner as reviewable files.
- Its **guardrails/HITL** deserve a dedicated review surface.
- Its release/publish cadence is independent of the platform's.

**What a service owns** (copy the DS shape): its **harness** (a real-toolchain
worker), its **loops**, its domain **context** distillers, its **tools** (a CLI),
its **guardrails/gates**, its **HITL** review surface, and its **state-as-files**.

**What the spine provides to every service:** auth, the dispatch/catalog seam,
and (as §5 lands) semantic memory, the eval program, and tracing.

**Extraction checklist** (what the DS extraction did, in order):
1. Move the domain code out of the monolith into a repo/monorepo (verbatim first,
   refactor after).
2. Replace DB state with committed files (manifest/contracts/tokens).
3. Replace serverless routes with a real-toolchain worker (GitHub Actions).
4. Stand up the admin UI (dispatch + poll + HITL review).
5. Prove it end-to-end on real data **before** retiring the monolith copy.
6. **Cutover:** remove the now-duplicated tool from the monolith (§6).

---

## 5. The three platform gaps (prioritized future work)

These are the cross-cutting capabilities the spine still lacks. Named and
prioritized here; each gets its own brainstorm→spec→plan→SDD when its feature
comes up. Priority order reflects leverage across future features.

### 5.1 Semantic memory (spine) — **Priority 1**
- **Why a gap:** state-as-files is durable *working* state, but there is no
  cross-session, cross-tool memory (what was tried, what the user prefers, entity
  history). Every new agent feature re-derives context from scratch.
- **Rough shape:** a spine memory service (embeddings + entity/temporal records)
  with retrieval scoped per tool; write-on-consolidation, not per-turn. The
  existing Voyage embedding setup is a starting point.
- **Done when:** a feature can recall a prior decision/preference without the user
  restating it, and retrieval is scoped so it doesn't pollute context.

### 5.2 Eval program (spine) — **Priority 2**
- **Why a gap:** per-run gates + fixtures exist, but there's no regression scoring
  across runs, no golden-set gating, no aggregate quality signal.
- **Rough shape:** a golden set per tool, an offline eval runner (deterministic +
  LLM-judge + visual), scored and tracked over time; a quality gate on releases.
- **Done when:** a change to a prompt/gate is scored against a golden set before it
  ships, and quality trend is visible.

### 5.3 Distributed tracing / observability (spine) — **Priority 3**
- **Why a gap:** job/cost rows and CI annotations are per-surface; there's no
  single trace correlating dispatch → worker → LLM calls → PR → merge, and no
  cross-service log correlation.
- **Rough shape:** a trace/span convention threaded through dispatch and the
  worker, with LLM-call spans (tokens/cost/latency) and a correlation id surfaced
  in the admin.
- **Done when:** one run is inspectable end-to-end from a single id.

*(Cross-service orchestration (§2.6 at platform scale) is a fourth, lower-priority
gap — not needed until there is more than one service.)*

---

## 6. Phase 6 — cutover (retire the old design-system tool from this repo)

The design-system tool now lives fully in the `design-system` service, so its
**duplicate** in this monolith is dead weight to remove.

- **Precondition — MET:** a real end-to-end run (live `codegen sync` + generate on
  the real Figma library) has been done and works. This was the gate for touching
  `ai-tools-app` destructively; it is now satisfied.
- **Remove from `ai-tools-app`:** the design-system routes, its DB tables
  (design_component / contract_json / related), the design-system Settings UI, and
  the codegen modules now duplicated in the `design-system` service's
  `packages/codegen`.
- **KEEP in `ai-tools-app`:** the **mockup / screen-rebuild** feature — it was
  never ported to the `design-system` monorepo and is a separate tool that stays
  in the monolith (per §3, unextracted tools live in the spine). Check its
  dependencies on any shared modules before deleting them.
- **Also:** refresh the stale `design-system` monorepo root README (still carries
  pre-migration `ai-tools-app` framing).
- **Safety:** this is **destructive and the first write into `ai-tools-app`** this
  effort makes. It gets its **own brainstorm→spec→plan→SDD**; removals are staged
  and reviewed; the mockup feature's dependencies on any shared code are checked
  before deleting shared modules.

*This section frames the cutover; the detailed cutover spec/plan is produced when
Phase 6 is executed (the "3" in the current sequence: architecture spec → cutover).*

---

## 7. Invariants every future feature must respect

Distilled from what the design-system service proved. A feature that violates one
of these needs an explicit, recorded decision.

1. **State as reviewable files** where the domain allows — not hidden DB state
   that drifts. Git is the reconcile/audit log.
2. **Bounded loops with a cost ceiling and human escalation** — no unbounded paid
   LLM loops; every loop degrades to "needs human."
3. **Deterministic gates before LLM spend** — cheap membership/build checks run
   first; the model is only paid when it must be.
4. **Human-gate destructive and outward-facing actions** — merges, deletes,
   publishes, external sends are never automatic; the human sees the diff first.
5. **Never auto-destroy real work** — reconcile/cleanup only removes never-used
   artifacts; anything with committed output is reported for a deliberate action.
6. **Read paths never 500** — every advisory fetch is guarded and degrades to a
   fallback; a missing/malformed input never crashes a page or run.
7. **No false-positive nudges** — signals to the human (staleness, findings) fire
   only on real evidence, and self-clear when the condition resolves.
8. **Structured, inspectable output** — worker output is data (contracts, result
   files, job/cost rows), not just prose, so downstream and observability can read it.

---

## Non-goals
- Not a migration runbook for every tool — only design-system is extracted; the
  rest stay in the monolith until §4 says otherwise.
- Not a detailed design of the three gaps (§5) — those are named/prioritized; each
  is designed when its feature is scheduled.
- Not the Phase 6 cutover plan itself (§6 frames it; the plan is separate).
