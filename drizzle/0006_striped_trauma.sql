CREATE TABLE "blocked_oauth_accounts" (
	"block_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	CONSTRAINT "blocked_oauth_accounts_provider_id_account_id_pk" PRIMARY KEY("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"normalized_email" varchar(320) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"blocked_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "blocked_oauth_accounts" ADD CONSTRAINT "blocked_oauth_accounts_block_id_user_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."user_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_oauth_accounts_block_id_idx" ON "blocked_oauth_accounts" USING btree ("block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_blocks_user_id_idx" ON "user_blocks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_blocks_normalized_email_idx" ON "user_blocks" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "user_blocks_created_at_idx" ON "user_blocks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_role_blocked_at_idx" ON "users" USING btree ("role","blocked_at");--> statement-breakpoint

-- user_blocks is the durable source of truth. Mirror its active-account state
-- onto users.blocked_at so authentication and draft reads stay cheap.
CREATE FUNCTION "public"."sync_user_blocked_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		UPDATE "public"."users"
		SET "blocked_at" = NEW."created_at"
		WHERE "id" = NEW."user_id";
		RETURN NEW;
	END IF;

	UPDATE "public"."users"
	SET "blocked_at" = NULL
	WHERE "id" = OLD."user_id";
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_blocks_sync_user_blocked_at"
AFTER INSERT OR DELETE ON "public"."user_blocks"
FOR EACH ROW
EXECUTE FUNCTION "public"."sync_user_blocked_at"();--> statement-breakpoint

-- Application hooks return friendly errors; this trigger is the final
-- authority for direct writes, races, and future email-change paths.
CREATE FUNCTION "public"."reject_blocked_user_email"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('agentplan:signup-policy'));

	IF TG_OP = 'UPDATE'
		AND OLD."blocked_at" IS NOT NULL
		AND NEW."email" IS DISTINCT FROM OLD."email"
	THEN
		RAISE EXCEPTION 'Blocked accounts cannot change email.' USING ERRCODE = 'P0001';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "public"."user_blocks"
		WHERE "normalized_email" = lower(btrim(NEW."email"))
	) THEN
		RAISE EXCEPTION 'This identity cannot register.' USING ERRCODE = 'P0001';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_reject_blocked_email"
BEFORE INSERT OR UPDATE OF "email" ON "public"."users"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_blocked_user_email"();--> statement-breakpoint

CREATE FUNCTION "public"."reject_blocked_oauth_account"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_blocked_at timestamp with time zone;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('agentplan:signup-policy'));

	SELECT "blocked_at"
	INTO target_blocked_at
	FROM "public"."users"
	WHERE "id" = NEW."user_id"
	FOR UPDATE;

	IF target_blocked_at IS NOT NULL THEN
		RAISE EXCEPTION 'Blocked accounts cannot link identities.' USING ERRCODE = 'P0001';
	END IF;

	IF NEW."provider_id" <> 'credential' AND EXISTS (
		SELECT 1
		FROM "public"."blocked_oauth_accounts"
		WHERE "provider_id" = NEW."provider_id"
			AND "account_id" = NEW."account_id"
	) THEN
		RAISE EXCEPTION 'This identity cannot register.' USING ERRCODE = 'P0001';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "accounts_reject_blocked_oauth_identity"
BEFORE INSERT OR UPDATE OF "provider_id", "account_id", "user_id" ON "public"."accounts"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_blocked_oauth_account"();--> statement-breakpoint

-- Lock the user row before admitting new credentials. Whichever side wins a
-- block/sign-in race either gets deleted by the blocker or sees blocked_at and
-- fails before the credential row is created.
CREATE FUNCTION "public"."reject_blocked_user_credential"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target_blocked_at timestamp with time zone;
BEGIN
	SELECT "blocked_at"
	INTO target_blocked_at
	FROM "public"."users"
	WHERE "id" = NEW."user_id"
	FOR UPDATE;

	IF target_blocked_at IS NOT NULL THEN
		RAISE EXCEPTION 'Blocked accounts cannot create credentials.' USING ERRCODE = 'P0001';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_reject_blocked_user"
BEFORE INSERT ON "public"."sessions"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_blocked_user_credential"();--> statement-breakpoint
CREATE TRIGGER "api_tokens_reject_blocked_user"
BEFORE INSERT ON "public"."api_tokens"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_blocked_user_credential"();
