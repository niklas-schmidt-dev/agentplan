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
		NEW."role" := 'admin';
	END IF;
	RETURN NEW;
END;
$$;
