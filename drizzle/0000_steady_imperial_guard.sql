CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"filename" varchar(512) NOT NULL,
	"format" varchar(32) DEFAULT 'md' NOT NULL,
	"blob_url" text NOT NULL,
	"status" varchar(32) DEFAULT 'processing' NOT NULL,
	"error_message" text,
	"title" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading_path" text,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"current_stage" varchar(64) DEFAULT 'business_requirements' NOT NULL,
	"status" varchar(32) DEFAULT 'in_progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_workflow_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_workflow_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"relevance_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool_key" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool_key" varchar(64) NOT NULL,
	"feature_workflow_id" uuid,
	"prompt_template_id" uuid,
	"model" varchar(128) NOT NULL,
	"used_project_context" boolean DEFAULT false NOT NULL,
	"status" varchar(32) DEFAULT 'completed' NOT NULL,
	"input_summary" text,
	"output_summary" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimate_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool_key" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"provider_base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) DEFAULT 'Default workspace' NOT NULL,
	"gitlab_url" text,
	"default_llm_provider_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_workflow" ADD CONSTRAINT "feature_workflow_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_workflow_document" ADD CONSTRAINT "feature_workflow_document_feature_workflow_id_feature_workflow_id_fk" FOREIGN KEY ("feature_workflow_id") REFERENCES "public"."feature_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_workflow_document" ADD CONSTRAINT "feature_workflow_document_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_template" ADD CONSTRAINT "prompt_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_feature_workflow_id_feature_workflow_id_fk" FOREIGN KEY ("feature_workflow_id") REFERENCES "public"."feature_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_prompt_template_id_prompt_template_id_fk" FOREIGN KEY ("prompt_template_id") REFERENCES "public"."prompt_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_settings" ADD CONSTRAINT "tool_settings_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_workspace_idx" ON "document" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_chunk_document_idx" ON "document_chunk" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_chunk_workspace_idx" ON "document_chunk" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "document_chunk_embedding_idx" ON "document_chunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "feature_workflow_workspace_idx" ON "feature_workflow" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_workflow_document_unique_idx" ON "feature_workflow_document" USING btree ("feature_workflow_id","document_id");--> statement-breakpoint
CREATE INDEX "prompt_template_workspace_tool_idx" ON "prompt_template" USING btree ("workspace_id","tool_key");--> statement-breakpoint
CREATE INDEX "run_workspace_tool_idx" ON "run" USING btree ("workspace_id","tool_key");--> statement-breakpoint
CREATE INDEX "run_feature_workflow_idx" ON "run" USING btree ("feature_workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_settings_workspace_tool_idx" ON "tool_settings" USING btree ("workspace_id","tool_key");