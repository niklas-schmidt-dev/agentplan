DROP INDEX "drafts_owner_updated_idx";--> statement-breakpoint
ALTER TABLE "upload_intent_files" ADD COLUMN "verified_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "completion_token" uuid;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "completion_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "verified_sha256" varchar(64);--> statement-breakpoint
CREATE INDEX "drafts_owner_updated_idx" ON "drafts" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);