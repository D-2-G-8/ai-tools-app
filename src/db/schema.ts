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
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Схема БД согласно PLAN.md, раздел 4.
 *
 * Однопользовательский режим: в MVP `workspace` фактически одна запись,
 * но все таблицы уже привязаны к workspaceId, чтобы позже добавить
 * многопользовательский режим без миграции структуры.
 *
 * Секретные токены (GitLab PAT, LLM provider token) НИКОГДА не хранятся
 * в этих таблицах — см. src/lib/session.ts.
 */

export const workspace = pgTable("workspace", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull().default("Default workspace"),
  // Не секреты — URL-ы можно хранить постоянно. Сами токены живут только
  // в сессионной cookie (см. src/lib/session.ts), никогда не попадают сюда.
  gitlabUrl: text("gitlab_url"),
  defaultLlmProviderUrl: text("default_llm_provider_url"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("document_workspace_idx").on(t.workspaceId)],
);

// Размерность эмбеддинга voyage-3-lite = 512. Если сменится модель эмбеддингов —
// поменять размерность здесь и пересоздать таблицу/индекс.
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
    providerBaseUrl: text("provider_base_url"), // без токена
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

// Практический "граф зависимостей": какие документы использовались как контекст
// при работе над конкретной фичей.
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
