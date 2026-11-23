-- Auto-approve now approves whatever passes the fixed-rule checks, with no
-- reviewed pull request behind it. A source turned on or requested under the
-- old meaning is turned off; a manager turns it on again.
DO $$
DECLARE
  reset integer;
BEGIN
  UPDATE "skill_git_sources"
    SET "auto_approve" = 'off',
        "auto_approve_requested_by" = NULL,
        "auto_approve_consented_by" = NULL,
        "auto_approve_grant_id" = NULL,
        "updated_at" = now()
    WHERE "auto_approve" <> 'off';
  GET DIAGNOSTICS reset = ROW_COUNT;
  IF reset > 0 THEN
    RAISE NOTICE '0329: auto-approve turned off on % GitHub skill sources; a manager turns it on again per skill', reset;
  END IF;
END $$;
