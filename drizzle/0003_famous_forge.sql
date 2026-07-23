CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
-- Existing deployments predate the first-user-is-admin signup hook: promote
-- the earliest-registered user so every instance has an admin.
UPDATE "users" SET "role" = 'admin' WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1);