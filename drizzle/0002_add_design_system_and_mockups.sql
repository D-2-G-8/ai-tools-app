CREATE TABLE "design_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"figma_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "design_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"category" varchar(32) NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"figma_node_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mockup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"feature_workflow_id" uuid,
	"name" varchar(255) NOT NULL,
	"filename" varchar(512) NOT NULL,
	"blob_url" text NOT NULL,
	"status" varchar(32) DEFAULT 'ready' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "figma_file_key" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "design_component_stack" varchar(32) DEFAULT 'react-css-modules' NOT NULL;--> statement-breakpoint
ALTER TABLE "design_component" ADD CONSTRAINT "design_component_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_token" ADD CONSTRAINT "design_token_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup" ADD CONSTRAINT "mockup_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mockup" ADD CONSTRAINT "mockup_feature_workflow_id_feature_workflow_id_fk" FOREIGN KEY ("feature_workflow_id") REFERENCES "public"."feature_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_component_workspace_slug_idx" ON "design_component" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "design_token_workspace_name_idx" ON "design_token" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "design_token_workspace_category_idx" ON "design_token" USING btree ("workspace_id","category");--> statement-breakpoint
CREATE INDEX "mockup_workspace_idx" ON "mockup" USING btree ("workspace_id");
