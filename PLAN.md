# AI Tools Platform — implementation plan

Date: 2026-07-19
Status: draft v1 (for discussion before development starts)

## 1. Vision

A single platform on Vercel with a suite of AI tools covering the entire feature development cycle:

- business requirements
- systems analysis / design
- design
- code (ideally without a developer's involvement — the developer only handles design and systems analysis)
- code review (a standalone tool already exists; it will be integrated and refined)
- automated tests (quality and coverage)

Each tool works on its own, but its quality improves dramatically when the platform has project context: uploaded documentation, code, and feature history. The user sets up the workspace once (uploads documents, configures integrations, picks models) — from then on the platform "remembers" them: run history, unfinished features, prompts, and settings.

## 2. Stack (finalized)

- **Next.js (App Router) + TypeScript** — a single full-stack app, deployed to Vercel as one project.
- **Vercel Postgres (Neon) + the `pgvector` extension** — the primary DB and embedding store in one place. ORM — Drizzle (it plays better with pgvector than Prisma).
- **Vercel Blob** — storage for raw uploaded files (documents, Confluence exports, code, etc.).
- **Vercel AI SDK** — a unified layer over LLM providers: Anthropic by default, but with support for an arbitrary `baseURL` + token that the user configures.
- **Orchestration of multi-step/background jobs** (document ingestion, the full feature cycle by stages) — a separate queue/workflow layer (Inngest or Trigger.dev), since Vercel's serverless functions are ill-suited to long synchronous processes (parsing large batches of documents, embeddings, multi-step tool chains).
- **Authentication** — single-user mode to start (no login screen), but the data model is designed with `workspaceId`/`userId` from the outset, so that Clerk/Auth.js and multi-user support can be added painlessly later.

## 3. A key principle: secrets are not stored

The user enters:

- the GitLab URL and token
- the LLM provider URL and token (if not the default Anthropic)

These tokens are **never written to the DB**. They are held only in an encrypted httpOnly session cookie (for example, via `iron-session`) for the duration of the browser session, and are sent to the server only when a specific tool is invoked. If the session has expired, the token must be entered again. Everything else (the URL without the token, model selection, default prompts, uploaded documents) is stored permanently.

## 4. Data model (draft)

- `workspace` — a unit of the user's "workspace" (in the MVP, effectively a single record)
- `document` — an uploaded file: name, Blob link, processing status (processing/ready/error), type
- `document_chunk` — a chunk of document text + `embedding vector` + metadata (source, section)
- `tool_settings` — per tool: the selected model, a custom provider URL (without the token)
- `prompt_template` — tied to a tool: name, text, a "default/custom" flag, an active flag
- `run` — a single tool invocation: which tool, which model, prompt, input/output, `input_tokens`/`output_tokens`, cost estimate, status, timestamp
- `feature_workflow` — a "feature" entity that we track through the full cycle: current stage, status, links to related `run`s
- (later) `user` — for multi-user mode, not required yet

## 5. Shared AI-tool contract

So that tools are both independent and part of a shared pipeline, each has a single interface:

- `key`, `name`, `description`
- `defaultPrompts()` — a set of out-of-the-box default prompts
- `run(input, { promptId, model, useProjectContext })` → result + `tokenUsage`
- `estimateCost(model, avgTokens)` — for the stats tab
- a `benefitsFromContext` flag — whether it uses graph/vector search over documents

This contract lets us add new tools as modules without touching the platform core.

## 6. Project context and the "dependency graph"

Implementation at the MVP stage: classic RAG over pgvector, rather than a separate graph DB (easier to introduce and maintain, cheaper on infrastructure).

**Formats to start: `.md` only.** Everything else (pdf, docx, Confluence export, a code repository) is deliberately deferred — we'll come back to it in a separate pass once the scaffold works on md.

Ingestion pipeline for `.md`:

1. **Extraction** — `.md` is already a text format, so a parser isn't needed in the sense of "decode a binary" (as it is for pdf/docx), but the structure does need to be parsed:
   - pull out the YAML frontmatter, if present (`---\ntitle: ...\n---`) — that's ready-made document metadata;
   - build a heading tree (`#`, `##`, `###`) — needed so we know which section a piece of text came from;
   - don't split code blocks (```) or tables down the middle — if a chunk gets cut, the boundary should fall on the block boundary, otherwise an embedding of a code fragment without context is useless.
2. **Chunking** — don't cut text "blindly" every N characters; cut by sections (by headings), and within a long section — by paragraphs with a size limit (e.g. ~500–800 tokens) and a small overlap, so context isn't lost at the chunk boundary.
3. **Per-chunk metadata** — the path to the source file, a heading "breadcrumb" (`H1 > H2 > H3`), the chunk number within the document. This is needed so that a tool's output can later cite the source ("see section X of document Y").
4. **Embedding** — each chunk is run through the LLM provider's embeddings endpoint; the vector + text + metadata are written to `document_chunk` (pgvector).
5. When generating a new document (e.g. a feature spec) — retrieval of relevant chunks + explicit "feature X references documents Y, Z" links are saved in `feature_workflow`; that's the practical "dependency graph" to start with.
6. A full graph DB (Neo4j) can be considered later, if the retrieval approach stops being enough for complex explicit relationships between entities.

## 7. Platform scaffold (MVP) — this is where we start

Order: the general platform first, then the code-review tool gets embedded into it as the first real tool.

1. **Layout and navigation** — a list of tools, moving between them.
2. **Settings** — LLM provider URL + token (per session), GitLab URL + token (per session), per-tool model selection (default — Anthropic).
3. **Document upload** — upload → Blob → background ingestion (chunks + embeddings) → ready status.
4. **History** — a list of past runs and features, including unfinished ones, with the ability to go back and continue.
5. **The "Prompts" tab** (per tool) — default prompts + creating/editing your own, selecting the active one.
6. **The "Stats" tab** — average token usage and cost estimate per request for each tool and model.
7. **The universal tool "runner"** — a launch screen: prompt/model selection, a "use project context" option, result output, saving to history.

## 8. Later phases (after the scaffold)

- **Phase 2** — integrating the existing code-review tool as the first module in the shared platform (we need to look at the code/API of the current implementation).
- **Phase 3** — improving code review by metrics (once we have quality data).
- **Phase 4** — one at a time, in separate design cycles: automated tests (quality/coverage), auto-coding, systems analysis/design, business requirements, design. Each is a separate deep dive, as agreed.
- **Phase 5** — end-to-end orchestration: the full feature-tracking cycle, where stages pass context to one another through `feature_workflow`.

## 9. Deliberately out of scope to start (MVP non-goals)

- Multi-user authentication and roles
- Billing/payments
- Team access / workspace sharing
- A full graph DB

The data schema must not block adding any of this later.

## 10. Immediate next steps

1. Initialize the Next.js + TypeScript project, connect Vercel Postgres (pgvector) and Blob.
2. Design and apply the DB schema (see section 4).
3. Build settings + document upload + background ingestion.
4. Build the "Prompts" and "Stats" tabs + the universal tool runner.
5. As soon as the code for the existing code-review tool is provided — design its integration as the first module.

## 11. Rough infrastructure cost (single-user mode, July 2026)

An estimate at the start, under light single-user load. Current prices were checked against the providers' official pages.

| Cost item | Plan | Roughly per month |
|---|---|---|
| Vercel Pro (subscription) | $20/mo; the subscription already includes a $20 usage credit for compute/bandwidth/Blob | $20 (under light usage there's almost no overage — the credit covers it) |
| Vercel Blob (files) | $0.023/GB-mo storage + a separate charge for traffic, beyond the free limits — paid from the Pro credit | ~$0 on top for a small volume of md files |
| Postgres + pgvector (Neon, via Vercel Marketplace) | Free plan: 0.5 GB storage + 100 CU-hours/project; beyond that pay-as-you-go — $0.106/CU-hour + $0.35/GB-mo, with no minimum charge | $0 to start, budget $5–10 for growth |
| Background jobs (Inngest) | Free (Hobby): 50,000 executions/mo, 5 concurrent — plenty for a single user; Pro — $99/mo, but not needed at this scale | $0 |
| LLM calls (Anthropic API) | Claude Sonnet: $2 / $10 per 1M input/output tokens (promotional price through 2026-08-31, then $3/$15); Haiku: $1/$5; Opus: $5/$25 | heavily dependent on usage volume — see the example below |
| Document embeddings | Claude has no embeddings API of its own; Anthropic recommends Voyage AI: voyage-3-lite $0.06 / voyage-3-large $0.18 per 1M tokens | cents even across dozens of md documents |

**Example LLM-cost calculation:** a code-review run with context of ~20K input tokens and ~2K output tokens on Sonnet ≈ (20,000/1,000,000)×$2 + (2,000/1,000,000)×$10 ≈ **$0.06 per run**. At 100–300 runs a month across all tools that's ≈ $6–20/mo; with heavier use, proportionally more. This is the most variable and unpredictable cost item, which is exactly why the "Stats" tab in the platform scaffold (section 7, item 6) is needed — so this figure is visible in actuals, not just in theory.

**Infrastructure total excluding LLM calls:** realistically $20/mo (essentially just the Vercel Pro subscription — Neon and Inngest fit within the free plans to start). **Including LLM calls**, with moderate personal use — roughly **$30–60/mo**, beyond which it depends on how many tool runs per month and which models are chosen (Sonnet is about 2× more expensive than Haiku).

Sources: [Vercel Pricing](https://vercel.com/pricing), [Vercel Blob Pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Neon Pricing](https://neon.com/pricing), [Claude Platform Pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Inngest Pricing](https://www.inngest.com/pricing), [Claude Embedding Models — Voyage AI pricing](https://tokenmix.ai/blog/claude-embedding-models)
