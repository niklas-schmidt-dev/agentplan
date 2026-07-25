CREATE TYPE "public"."upload_intent_mode" AS ENUM('single', 'bundle', 'bundle_restore');--> statement-breakpoint
CREATE TABLE "draft_version_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"logical_path" varchar(512) NOT NULL,
	"storage_key" text NOT NULL,
	"content_sha256" char(64) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intent_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"logical_path" varchar(512) NOT NULL,
	"final_key" text NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"expected_bytes" integer NOT NULL,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intent_reclaims" (
	"intent_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"size_bytes" integer NOT NULL,
	CONSTRAINT "upload_intent_reclaims_intent_id_version_id_pk" PRIMARY KEY("intent_id","version_id")
);
--> statement-breakpoint
ALTER TABLE "upload_intents" ALTER COLUMN "staging_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_versions" ADD COLUMN "total_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "draft_versions" ADD COLUMN "entry_path" varchar(512);--> statement-breakpoint
ALTER TABLE "draft_versions" ADD COLUMN "is_bundle" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "mode" "upload_intent_mode" DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "entry_path" varchar(512);--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "file_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_version_assets" ADD CONSTRAINT "draft_version_assets_version_id_draft_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."draft_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intent_files" ADD CONSTRAINT "upload_intent_files_intent_id_upload_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."upload_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intent_reclaims" ADD CONSTRAINT "upload_intent_reclaims_intent_id_upload_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."upload_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intent_reclaims" ADD CONSTRAINT "upload_intent_reclaims_version_id_draft_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."draft_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_version_assets_version_path_idx" ON "draft_version_assets" USING btree ("version_id","logical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_version_assets_storage_key_idx" ON "draft_version_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "draft_version_assets_version_idx" ON "draft_version_assets" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intent_files_intent_path_idx" ON "upload_intent_files" USING btree ("intent_id","logical_path");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intent_files_final_key_idx" ON "upload_intent_files" USING btree ("final_key");--> statement-breakpoint
CREATE INDEX "upload_intent_files_intent_idx" ON "upload_intent_files" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_intent_reclaims_version_idx" ON "upload_intent_reclaims" USING btree ("version_id");