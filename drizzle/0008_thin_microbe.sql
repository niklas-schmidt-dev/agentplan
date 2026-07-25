CREATE TYPE "public"."draft_kind" AS ENUM('html', 'image', 'video');--> statement-breakpoint
CREATE TYPE "public"."upload_intent_status" AS ENUM('pending', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "storage_deletion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"reason" varchar(50) NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(100),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"target_draft_id" uuid,
	"draft_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"staging_key" text NOT NULL,
	"final_key" text NOT NULL,
	"kind" "draft_kind" NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"expected_bytes" integer NOT NULL,
	"title" varchar(200),
	"visibility" "draft_visibility",
	"password_hash" text,
	"source" "version_source" NOT NULL,
	"created_by_token_id" uuid,
	"status" "upload_intent_status" DEFAULT 'pending' NOT NULL,
	"failure_code" varchar(50),
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_versions" ADD COLUMN "original_filename" varchar(255);--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "kind" "draft_kind" DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_target_draft_id_drafts_id_fk" FOREIGN KEY ("target_draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_created_by_token_id_api_tokens_id_fk" FOREIGN KEY ("created_by_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_deletion_jobs_storage_key_idx" ON "storage_deletion_jobs" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "storage_deletion_jobs_retry_idx" ON "storage_deletion_jobs" USING btree ("next_attempt_at","not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intents_staging_key_idx" ON "upload_intents" USING btree ("staging_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intents_final_key_idx" ON "upload_intents" USING btree ("final_key");--> statement-breakpoint
CREATE INDEX "upload_intents_owner_status_expiry_idx" ON "upload_intents" USING btree ("owner_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "upload_intents_target_draft_idx" ON "upload_intents" USING btree ("target_draft_id");