ALTER TABLE "mockup" ALTER COLUMN "blob_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "source" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "figma_file_key" text;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "figma_node_id" text;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "preview_blob_url" text;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "structure_text" text;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "uses_components" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mockup" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "mockup_workspace_figma_node_idx" ON "mockup" USING btree ("workspace_id","figma_node_id");