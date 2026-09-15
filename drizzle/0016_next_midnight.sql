ALTER TABLE "drafts" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "draft_expires_in_seconds" integer;--> statement-breakpoint
CREATE INDEX "drafts_expires_at_idx" ON "drafts" USING btree ("expires_at");