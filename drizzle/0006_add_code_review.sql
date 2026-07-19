ALTER TABLE "run" ADD COLUMN "gitlab_project_id" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "gitlab_mr_iid" text;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "review_version" varchar(8);--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "findings_json" jsonb;--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "posted_to_gitlab_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "gitlab_project_ids" text;