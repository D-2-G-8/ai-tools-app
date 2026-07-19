DROP INDEX "tool_settings_workspace_tool_idx";--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_settings" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_settings" ADD CONSTRAINT "tool_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_settings_workspace_tool_user_idx" ON "tool_settings" USING btree ("workspace_id","tool_key","user_id");