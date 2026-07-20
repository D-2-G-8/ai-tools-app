ALTER TABLE "design_component" ADD COLUMN "last_code_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "design_component" ADD COLUMN "last_code_commit_sha" varchar(64);--> statement-breakpoint
ALTER TABLE "design_component" ADD COLUMN "code_sync_status" varchar(16) DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "design_system_pending_pr_url" text;