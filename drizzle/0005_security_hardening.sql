-- The application authorizes the bootstrap identity from
-- ADMIN_BOOTSTRAP_EMAIL and marks that insert as admin. The database remains
-- the final authority: an empty deployment rejects default/user-role inserts
-- instead of granting admin to whichever public request arrives first.
CREATE OR REPLACE FUNCTION "public"."assign_first_user_admin"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	signups_enabled boolean;
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('agentplan:signup-policy'));
	IF EXISTS (SELECT 1 FROM "public"."users") THEN
		SELECT COALESCE(
			(
				SELECT "value" = 'true'::jsonb
				FROM "public"."app_settings"
				WHERE "key" = 'signups_enabled'
			),
			true
		)
		INTO signups_enabled;
		IF NOT signups_enabled THEN
			RAISE EXCEPTION 'Sign-ups are currently disabled.' USING ERRCODE = 'P0001';
		END IF;
		NEW."role" := 'user';
	ELSE
		IF NEW."role" <> 'admin' THEN
			RAISE EXCEPTION 'Initial administrator registration is restricted.' USING ERRCODE = 'P0001';
		END IF;
		NEW."role" := 'admin';
	END IF;
	RETURN NEW;
END;
$$;

-- Existing protected links may contain title-derived metadata. Rotate them
-- once to cryptographically random UUID-based slugs.
UPDATE "public"."drafts"
SET "slug" = 'draft-' || replace(gen_random_uuid()::text, '-', '')
WHERE "visibility" <> 'public';
