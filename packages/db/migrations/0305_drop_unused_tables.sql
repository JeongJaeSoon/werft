-- No release reads or writes these tables. catalog_authority and
-- owner_workspace_map were never used by a tagged release, so the first one
-- stands for them; push_continuations' last writer was v0.1.1.
-- contract: catalog_authority last used by v0.1.0
-- contract: owner_workspace_map last used by v0.1.0
-- contract: push_continuations last used by v0.1.1
-- Counts only: what the rows held stays out of the log.
DO $$
DECLARE
  authority integer;
  mapped integer;
  continuations integer;
BEGIN
  SELECT count(*) INTO authority FROM "catalog_authority";
  SELECT count(*) INTO mapped FROM "owner_workspace_map";
  SELECT count(*) INTO continuations FROM "push_continuations";
  IF authority > 0 OR mapped > 0 OR continuations > 0 THEN
    RAISE NOTICE '0305: dropped rows: catalog_authority %, owner_workspace_map %, push_continuations %', authority, mapped, continuations;
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "catalog_authority";--> statement-breakpoint
DROP TABLE "owner_workspace_map";--> statement-breakpoint
DROP TABLE "push_continuations";
