ALTER TABLE "document" ADD COLUMN "edit_locked_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "edit_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_edit_locked_by_user_id_user_id_fk" FOREIGN KEY ("edit_locked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;