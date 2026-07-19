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
  defaultLlmProviderUrl: text("default_llm_provider_url"),
  // Design System settings (see design-system pages under src/app/design-system).
  // The Figma file itself is only ever read through the Figma MCP connector
  // (during a Claude session) or, later, a per-user Figma token entered in
  // Settings the same way the GitLab token works — never stored here.
  figmaFileKey: text("figma_file_key"),
  designComponentStack: varchar("design_component_stack", { length: 32 })
    .notNull()
    .default("react-css-modules"),
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
    model: varchar("model", { length: 128 }).notNull(),
    providerBaseUrl: text("provider_base_url"), // without token
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tool_settings_workspace_tool_idx").on(t.workspaceId, t.toolKey)],
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
    usedProjectContext: boolean("used_project_context").notNull().default(false),
    status: varchar("status", { length: 32 }).notNull().default("completed"), // running | completed | error
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    // Set once a chat-style tool (e.g. Business Requirements) compiles its
    // final output into a project document — lets the UI link straight to it.
    resultDocumentId: uuid("result_document_id").references(() => document.id, { onDelete: "set null" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("design_component_workspace_slug_idx").on(t.workspaceId, t.slug)],
);

export const mockupStatusValues = ["ready", "error"] as const;
export type MockupStatus = (typeof mockupStatusValues)[number];

/**
 * A design mockup: a self-contained HTML page built from Design System
 * tokens/components (see docs/conventions-equivalent notes). Mirrors the
 * Blob-backed storage approach of `document` (src/app/documents), but kept
 * as its own table since mockups render as live HTML rather than being
 * chunked/embedded for RAG.
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
    blobUrl: text("blob_url").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("ready"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mockup_workspace_idx").on(t.workspaceId)],
);
