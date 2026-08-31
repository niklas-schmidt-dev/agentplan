CREATE TYPE "public"."draft_viewer_kind" AS ENUM('owner', 'user', 'anonymous');--> statement-breakpoint
CREATE TABLE "draft_view_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"viewer" "draft_viewer_kind" NOT NULL,
	"visitor_hash" char(64),
	"country" char(2),
	"referrer_host" varchar(255),
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "draft_view_events" ADD CONSTRAINT "draft_view_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_view_events_draft_viewed_idx" ON "draft_view_events" USING btree ("draft_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "draft_view_events_viewed_at_idx" ON "draft_view_events" USING btree ("viewed_at");