import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  numeric,
  boolean,
  vector,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * DB schema per PLAN.md, section 4.
 *
 * Multi-company mode (see README "Authentication setup"): every real user
 * belongs to exactly one `company` (via `user.companyId`), and every
 * `company` has exactly one `workspace` (via `workspace.companyId`) — all
 * the workspace-scoped tables below (document, run, promptTemplate, etc.)
 * are unchanged by this and still just key off `workspaceId`, they simply
 * now resolve that id through the signed-in user's company instead of a
 * single global row (see src/db/workspace.ts, getCurrentWorkspaceId).
 *
 * Secret tokens (GitLab PAT, LLM provider token) are NEVER stored in
 * these tables — see src/lib/session.ts. Auth.js session/account data
 * (Google OAuth tokens) IS stored in `account`/`session` below, since
 * that's Auth.js's own adapter contract, not a user-entered secret in the
 * session.ts sense.
 */

// --- Auth.js (NextAuth v5) tables -------------------------------------
// Shape required by @auth/drizzle-adapter's Postgres adapter. `user.id`
// uses uuid/defaultRandom() (like every other table here) rather than the
// adapter's default text id — this is a supported customization as long as
// the column names/semantics match what the adapter expects.

export const company = pgTable("company", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  // Explicit AnyPgColumn return type breaks the company<->user circular
  // type inference (user.companyId references company.id right below).
  createdByUserId: uuid("created_by_user_id").references((): AnyPgColumn => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companyRoleValues = ["owner", "member"] as const;
export type CompanyRole = (typeof companyRoleValues)[number];

export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  // Nullable until the user finishes onboarding (create/join a company) —
  // see src/app/onboarding.
  companyId: uuid("company_id").references((): AnyPgColumn => company.id, { onDelete: "set null" }),
  companyRole: varchar("company_role", { length: 16 }), // "owner" | "member", null until in a company
  // Bumped by touchPresence() (src/app/(protected)/presence-actions.ts) on
  // page loads / a client-side heartbeat while a protected page is open --
  // see src/lib/format-relative-time.ts / the company page for how "online"
  // is derived (within a short freshness window) from this.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable(
  "account",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: varchar("token_type", { length: 32 }),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const session = pgTable("session", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationToken = pgTable(
  "verification_token",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// --- Company membership -------------------------------------------------

export const companyInviteStatusValues = ["pending", "accepted"] as const;
export type CompanyInviteStatus = (typeof companyInviteStatusValues)[number];

/**
 * A pending (or already-accepted) invite for a specific email to join a
 * company. No email is actually sent (no transactional-email provider in
 * this app) — an invite just auto-activates the next time that address
 * signs in with Google (see src/app/onboarding/actions.ts); the inviter
 * has to tell the invitee out-of-band that they've been invited.
 */
export const companyInvite = pgTable(
  "company_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(), // stored lowercased
    invitedByUserId: uuid("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("company_invite_company_email_idx").on(t.companyId, t.email),
    index("company_invite_email_idx").on(t.email),
  ],
);

export const componentStackValues = [
  "react-scss",
  "react-css-modules",
  "none",
] as const;
export type ComponentStack = (typeof componentStackValues)[number];

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable so the pre-auth default workspace row needs no data backfill —
  // it gets adopted by whichever company is created first after this ships
  // (see src/app/onboarding/actions.ts, createCompany). Every workspace
  // created from that point on always has this set.
  companyId: uuid("company_id").references(() => company.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull().default("Default workspace"),
  // Not secrets — URLs can be stored permanently. The tokens themselves live
  // only in the session cookie (see src/lib/session.ts), never end up here.
  gitlabUrl: text("gitlab_url"),
  // Comma-separated GitLab project IDs/paths this workspace's AI Review
  // pulls open MRs from (see src/lib/gitlab/client.ts, code-review-panel.tsx).
  // Not a secret -- the GitLab token itself stays session-only.
  gitlabProjectIds: text("gitlab_project_ids"),
  defaultLlmProviderUrl: text("default_llm_provider_url"),
  // Design System settings (see design-system pages under src/app/design-system).
  // The Figma file itself is only ever read through the Figma MCP connector
  // (during a Claude session) or, later, a per-user Figma token entered in
  // Settings the same way the GitLab token works — never stored here.
  figmaFileKey: text("figma_file_key"),
  designComponentStack: varchar("design_component_stack", { length: 32 })
    .notNull()
    .default("react-css-modules"),
  // Set when a design-system code-sync session (see src/lib/design-system-codegen/)
  // opens a pull request in the separate design-system repo; cleared once that PR
  // is merged or closed. Drives the "Review & confirm" banner in
  // design-system/settings -- generated code never reaches that repo's base
  // branch without a person explicitly clicking "Confirm & merge" there.
  designSystemPendingPrUrl: text("design_system_pending_pr_url"),
  // The branch backing designSystemPendingPrUrl above -- committing more
  // files onto an already-open PR means committing onto ITS branch (you
  // can't commit "into" a PR directly). Lets targeted resyncs ("Resync
  // this component", "Resync tokens") and a later full "Generate code" run
  // all land on the same not-yet-merged PR instead of opening parallel
  // duplicate ones (see src/lib/design-system-codegen/session.ts).
  designSystemPendingPrBranch: text("design_system_pending_pr_branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentStatusValues = [
  "processing",
  "ready",
  "error",
] as const;
export type DocumentStatus = (typeof documentStatusValues)[number];

export const document = pgTable(
  "document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 512 }).notNull(),
    format: varchar("format", { length: 32 }).notNull().default("md"),
    blobUrl: text("blob_url").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("processing"),
    errorMessage: text("error_message"),
    title: text("title"),
    chunkCount: integer("chunk_count").notNull().default(0),
    // Nullable -- documents created before this shipped have no recorded
    // author/editor, and both go null if that user's account is ever
    // removed (onDelete: set null) rather than the document disappearing.
    createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    updatedByUserId: uuid("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
    // Soft, TTL-based edit lock (see src/db/edit-lock.ts) -- set while
    // someone has the edit page open, cleared on save/cancel, and treated
    // as expired (ignored) after EDIT_LOCK_TTL_MS regardless, so a crashed
    // tab or closed browser can never lock a document forever.
    editLockedByUserId: uuid("edit_locked_by_user_id").references(() => user.id, { onDelete: "set null" }),
    editLockedAt: timestamp("edit_locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_workspace_idx").on(t.workspaceId)],
);

// The voyage-3-lite embedding dimension = 512. If the embedding model changes —
// update the dimension here and recreate the table/index.
export const EMBEDDING_DIMENSIONS = 512;

export const documentChunk = pgTable(
  "document_chunk",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    headingPath: text("heading_path"), // "H1 > H2 > H3"
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("document_chunk_document_idx").on(t.documentId),
    index("document_chunk_workspace_idx").on(t.workspaceId),
    index("document_chunk_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const toolSettings = pgTable(
  "tool_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    toolKey: varchar("tool_key", { length: 64 }).notNull(),
    // Nullable -- NULL rows predate per-user model settings and are treated
    // as the company-wide fallback for anyone who hasn't picked their own
    // model yet (see src/lib/tools/model-settings.ts, getEffectiveModel()).
    // Every row written by the current Settings page has this set; the app
    // never creates a new NULL row, so there is at most one legacy row per
    // (workspaceId, toolKey).
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    model: varchar("model", { length: 128 }).notNull(),
    providerBaseUrl: text("provider_base_url"), // without token
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tool_settings_workspace_tool_user_idx").on(t.workspaceId, t.toolKey, t.userId)],
);

export const promptTemplate = pgTable(
  "prompt_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    toolKey: varchar("tool_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    content: text("content").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("prompt_template_workspace_tool_idx").on(t.workspaceId, t.toolKey)],
);

export const featureWorkflow = pgTable(
  "feature_workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    currentStage: varchar("current_stage", { length: 64 }).notNull().default("business_requirements"),
    status: varchar("status", { length: 32 }).notNull().default("in_progress"), // in_progress | done | archived
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("feature_workflow_workspace_idx").on(t.workspaceId)],
);

// A practical "dependency graph": which documents were used as context
// while working on a particular feature.
export const featureWorkflowDocument = pgTable(
  "feature_workflow_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featureWorkflowId: uuid("feature_workflow_id")
      .notNull()
      .references(() => featureWorkflow.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    relevanceNote: text("relevance_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_workflow_document_unique_idx").on(t.featureWorkflowId, t.documentId),
  ],
);

// A single AI Review finding, as stored in run.findingsJson (see below) --
// shape mirrors src/lib/code-review/schema.ts's zod findings schema.
// Kept as a plain interface here (not imported from lib/code-review) so the
// schema module has no dependency on the review-engine module.
export interface CodeReviewFindingRecord {
  file: string;
  severity: "critical" | "high" | "medium";
  bug: string;
  why: string;
  // Cross-review fields (V2/V3 only) -- how many independent reviewers
  // agreed, and the judge's verdict. Absent for V1 (single reviewer, no
  // reconciliation pass).
  agreement?: number;
  verdict?: "confirmed" | "needs_verification";
}

export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    toolKey: varchar("tool_key", { length: 64 }).notNull(),
    featureWorkflowId: uuid("feature_workflow_id").references(() => featureWorkflow.id, {
      onDelete: "set null",
    }),
    promptTemplateId: uuid("prompt_template_id").references(() => promptTemplate.id, {
      onDelete: "set null",
    }),
    model: varchar("model", { length: 128 }).notNull(),
    // Nullable -- runs created before this shipped have no recorded user,
    // and it goes null if that user's account is ever removed (onDelete:
    // set null) rather than the run (and its cost history) disappearing.
    // Powers "your usage" on the tool Stats tab and the by-member breakdown
    // on the Company page.
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    usedProjectContext: boolean("used_project_context").notNull().default(false),
    status: varchar("status", { length: 32 }).notNull().default("completed"), // running | completed | error
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    // Set once a chat-style tool (e.g. Business Requirements) compiles its
    // final output into a project document — lets the UI link straight to it.
    resultDocumentId: uuid("result_document_id").references(() => document.id, { onDelete: "set null" }),
    // AI Review (toolKey "code-review") fields -- nullable/unused by every
    // other tool. See src/lib/code-review/*.ts and code-review-actions.ts.
    // Findings are stored as jsonb rather than a child table: this is the
    // full result of a single review run and is never queried piecemeal.
    gitlabProjectId: text("gitlab_project_id"),
    gitlabMrIid: text("gitlab_mr_iid"),
    reviewVersion: varchar("review_version", { length: 8 }), // "v1" | "v2" | "v3"
    findingsJson: jsonb("findings_json").$type<CodeReviewFindingRecord[]>(),
    // Set once the user explicitly posts the findings comment back to the
    // MR (a separate step from running the review -- see code-review-panel.tsx).
    postedToGitlabAt: timestamp("posted_to_gitlab_at", { withTimezone: true }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costEstimateUsd: numeric("cost_estimate_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_workspace_tool_idx").on(t.workspaceId, t.toolKey),
    index("run_feature_workflow_idx").on(t.featureWorkflowId),
  ],
);

/**
 * Turn-by-turn transcript for chat-style tools (currently: Business
 * Requirements). One `run` = one conversation. Kept separate from `run`
 * itself so the transcript can grow freely without touching the run row.
 */
export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(), // "user" | "assistant"
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_message_run_idx").on(t.runId)],
);

/**
 * Design System (see PLAN.md-equivalent notes in src/app/design-system):
 * a browsable snapshot of the project's design tokens and components,
 * synced from Figma. `design_token`/`design_component` are a SNAPSHOT, not
 * a live mirror — re-syncing overwrites rows matched by (workspaceId, name)
 * / (workspaceId, slug) rather than appending duplicates.
 */

export const designTokenCategoryValues = [
  "color",
  "typography",
  "spacing",
  "radius",
  "shadow",
  "duration",
  "other",
] as const;
export type DesignTokenCategory = (typeof designTokenCategoryValues)[number];

export const designToken = pgTable(
  "design_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(), // e.g. "text-primary", "font-heading-1"
    category: varchar("category", { length: 32 }).notNull(),
    value: text("value").notNull(), // CSS-ready value, e.g. "#0B0B0C" or "400 16px/22px Inter"
    description: text("description"),
    figmaNodeId: varchar("figma_node_id", { length: 64 }),
    // Set whenever this token was included in a tokens.css commit to the
    // design-system repo (src/lib/design-system-codegen/tokens.ts's
    // serializer regenerates the WHOLE file from every currently-synced
    // token each time it runs, so every row present at that moment gets
    // stamped) -- null means this token exists only as platform metadata
    // and was never actually shipped as code. Mirrors designComponent's
    // codeSyncStatus/lastCodeSyncAt below, but simpler: tokens.css commits
    // are synchronous (no async "pending" state to represent), and one
    // token can't be "committed" independently of the rest since the file
    // is always regenerated in full -- so a single nullable timestamp is
    // enough. Drives whether deleting a token is a plain DB delete or also
    // needs a commit removing it from tokens.css (see design-system/
    // settings/cleanup-actions.ts).
    lastCodeSyncAt: timestamp("last_code_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("design_token_workspace_name_idx").on(t.workspaceId, t.name),
    index("design_token_workspace_category_idx").on(t.workspaceId, t.category),
  ],
);

export interface DesignComponentVariant {
  name: string;
  description?: string;
}

export interface DesignComponentState {
  name: string;
  description?: string;
}

// "never" -- no code generated yet (or designComponentStack is "none").
// "pending" -- a generation request is in flight (async, see
//   src/app/api/design-system/codegen/[slug]/route.ts) -- distinct from
//   "never" so the UI can show "generating..." rather than looking stuck.
// "committed" -- generated and committed to the design-system repo (whether
//   or not its PR has been merged yet -- see workspace.designSystemPendingPrUrl
//   for that).
// "failed" -- the last generation attempt errored; lastCodeSyncAt/
//   lastCodeCommitSha keep whatever the previous successful attempt was.
export const codeSyncStatusValues = ["never", "pending", "committed", "failed"] as const;
export type CodeSyncStatus = (typeof codeSyncStatusValues)[number];

/**
 * The generated component's API contract (props + tokens + class names),
 * persisted so a DEPENDENT component's codegen/review can validate the values
 * it passes to this one (and so the self gate can validate this component's own
 * stories). Null for icons (no LLM contract) and for components committed
 * before this column existed (their composition just can't be value-checked
 * until they regenerate). Only `props[].{name,type}` is read by the gates.
 */
export interface StoredComponentContract {
  props: { name: string; type: string; description?: string }[];
  cssVariables?: string[];
  classNames?: string[];
}

export const designComponent = pgTable(
  "design_component",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(), // "accordion", "button"
    name: varchar("name", { length: 128 }).notNull(), // display name, e.g. "Accordion"
    description: text("description"),
    variants: jsonb("variants").$type<DesignComponentVariant[]>().notNull().default([]),
    states: jsonb("states").$type<DesignComponentState[]>().notNull().default([]),
    figmaNodeIds: jsonb("figma_node_ids").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    // True for a Figma component/set that looks like a single icon rather
    // than a real UI component -- see src/lib/figma/sync.ts's
    // isLikelyIconName doc comment for the exact (best-effort, no-Figma-
    // API-field-for-this heuristic). Icon libraries commonly run into the
    // hundreds of entries, so they get their own "Icons" tab (a dense
    // grid, see design-system/icons/page.tsx) instead of cluttering the
    // Components list one full card at a time.
    isIcon: boolean("is_icon").notNull().default(false),
    // React/CSS code generation tracking (src/lib/design-system-codegen/) --
    // separate from the Figma metadata sync above, see that module's doc
    // comment for why. Never touched by the metadata-only Figma sync itself.
    lastCodeSyncAt: timestamp("last_code_sync_at", { withTimezone: true }),
    lastCodeCommitSha: varchar("last_code_commit_sha", { length: 64 }),
    codeSyncStatus: varchar("code_sync_status", { length: 16 }).notNull().default("never"),
    // See StoredComponentContract above. Written on a successful LLM-path
    // commit (route.ts); never by the metadata-only Figma sync.
    contractJson: jsonb("contract_json").$type<StoredComponentContract>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("design_component_workspace_slug_idx").on(t.workspaceId, t.slug)],
);

export const mockupStatusValues = ["ready", "error"] as const;
export type MockupStatus = (typeof mockupStatusValues)[number];

// Where a mockup came from:
//  "manual" -- uploaded/edited HTML (the original flow).
//  "ai"     -- AI-generated from the design system (+ figma reference mockups).
//  "figma"  -- an existing app SCREEN imported from Figma as a historical
//              reference: a screenshot + a distilled structure spec + which
//              design-system components it uses. Re-imported by the "Sync
//              mockups from Figma" button (designers keep doing complex work in
//              Figma). These ground AI mockup generation on the real product.
export const mockupSourceValues = ["manual", "ai", "figma"] as const;
export type MockupSource = (typeof mockupSourceValues)[number];

/**
 * A design mockup. Either a self-contained HTML page built from Design System
 * tokens/components (source "manual"/"ai", stored in Blob like `document`), or
 * an existing app screen imported from Figma (source "figma": a screenshot in
 * Blob + a distilled structure + the design-system components it uses). Kept as
 * its own table since mockups render as live HTML / preview images rather than
 * being chunked/embedded for RAG.
 */
export const mockup = pgTable(
  "mockup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    featureWorkflowId: uuid("feature_workflow_id").references(() => featureWorkflow.id, {
      onDelete: "set null",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    filename: varchar("filename", { length: 512 }).notNull(),
    // The HTML page in Blob -- present for "manual"/"ai" mockups, null for a
    // "figma" reference (which has previewBlobUrl + structureText instead).
    blobUrl: text("blob_url"),
    source: varchar("source", { length: 16 }).notNull().default("manual"),
    // Figma origin, for re-syncing a "figma" reference mockup.
    figmaFileKey: text("figma_file_key"),
    figmaNodeId: text("figma_node_id"),
    // Screenshot (PNG in Blob) of the imported Figma screen -- the visual
    // reference AI generation is grounded on.
    previewBlobUrl: text("preview_blob_url"),
    // Distilled layout/structure spec of the screen (same distiller as
    // component codegen), and the design-system component slugs it composes.
    structureText: text("structure_text"),
    usesComponents: jsonb("uses_components").$type<string[]>().notNull().default([]),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    status: varchar("status", { length: 32 }).notNull().default("ready"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mockup_workspace_idx").on(t.workspaceId),
    // Re-sync looks a figma reference up by its source node -- unique so a
    // re-import updates in place instead of duplicating.
    uniqueIndex("mockup_workspace_figma_node_idx").on(t.workspaceId, t.figmaNodeId),
  ],
);
