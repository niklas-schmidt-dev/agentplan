ALTER TYPE "public"."draft_visibility" ADD VALUE 'password';--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "password_hash" text;