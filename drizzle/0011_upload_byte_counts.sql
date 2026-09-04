ALTER TABLE "draft_version_assets" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "draft_versions" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "draft_versions" ALTER COLUMN "total_size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "upload_intent_files" ALTER COLUMN "expected_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "upload_intent_reclaims" ALTER COLUMN "size_bytes" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "upload_intents" ALTER COLUMN "expected_bytes" SET DATA TYPE bigint;