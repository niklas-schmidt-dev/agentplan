CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"parent_id" uuid,
	"name" varchar(120) NOT NULL,
	"description" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_not_own_parent" CHECK ("groups"."id" <> "groups"."parent_id")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "target_group_id" uuid;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_parent_id_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "groups_owner_parent_created_idx" ON "groups" USING btree ("owner_id","parent_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "groups_parent_idx" ON "groups" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_target_group_id_groups_id_fk" FOREIGN KEY ("target_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drafts_group_idx" ON "drafts" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "drafts_owner_group_updated_idx" ON "drafts" USING btree ("owner_id","group_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "upload_intents_target_group_idx" ON "upload_intents" USING btree ("target_group_id");