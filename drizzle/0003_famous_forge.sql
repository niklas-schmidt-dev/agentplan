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
UPDATE "users" SET "role" = 'admin' WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC LIMIT 1);--> statement-breakpoint
-- Serialize first-user inserts inside the same transaction as the insert. The
-- application hook still decides the expected role, while this trigger closes
-- the empty-table race between concurrent sign-ups.
CREATE FUNCTION "public"."assign_first_user_admin"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('agentplan:first-user-admin'));
	IF EXISTS (SELECT 1 FROM "public"."users") THEN
		NEW."role" := 'user';
	ELSE
		NEW."role" := 'admin';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_assign_first_admin"
BEFORE INSERT ON "public"."users"
FOR EACH ROW
EXECUTE FUNCTION "public"."assign_first_user_admin"();
