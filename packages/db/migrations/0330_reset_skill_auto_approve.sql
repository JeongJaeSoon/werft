-- Auto-approve now approves whatever passes the fixed-rule checks, with no
-- reviewed pull request behind it. A source turned on or requested under the
-- old meaning is turned off; a manager turns it on again. The new column
-- holds the grant as a host that knows this meaning writes it, so an `on`
-- that a host from before writes later is told apart and reads as off.
ALTER TABLE "skill_git_sources" ADD COLUMN "auto_approve_checks_grant_id" uuid;--> statement-breakpoint
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
    RAISE NOTICE '0330: auto-approve turned off on % GitHub skill sources; a manager turns it on again per skill', reset;
  END IF;
END $$;
