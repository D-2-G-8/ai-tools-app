CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run" ADD COLUMN "result_document_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_message_run_idx" ON "chat_message" USING btree ("run_id");--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_result_document_id_document_id_fk" FOREIGN KEY ("result_document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;