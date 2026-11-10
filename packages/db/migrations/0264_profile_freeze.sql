CREATE TABLE "profile_freeze" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"writes_frozen" boolean DEFAULT false NOT NULL,
	"reconcile_generation" bigint DEFAULT 0 NOT NULL,
	"certified_generation" bigint,
	"phase" text DEFAULT 'open' NOT NULL,
	"cleanup_started_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"receipt" text,
	CONSTRAINT "profile_freeze_single" CHECK ("profile_freeze"."id" = 1),
	CONSTRAINT "profile_freeze_phase_check" CHECK ("profile_freeze"."phase" IN ('open', 'certified', 'cleanup_started', 'finalized')),
	CONSTRAINT "profile_freeze_generation_check" CHECK ("profile_freeze"."reconcile_generation" >= 0
        AND ("profile_freeze"."certified_generation" IS NULL OR "profile_freeze"."certified_generation" = "profile_freeze"."reconcile_generation")),
	CONSTRAINT "profile_freeze_phase_state_check" CHECK (("profile_freeze"."phase" = 'open' AND "profile_freeze"."certified_generation" IS NULL)
        OR ("profile_freeze"."phase" <> 'open' AND "profile_freeze"."writes_frozen" AND "profile_freeze"."certified_generation" IS NOT NULL)),
	CONSTRAINT "profile_freeze_marks_check" CHECK (("profile_freeze"."cleanup_started_at" IS NOT NULL) = ("profile_freeze"."phase" IN ('cleanup_started', 'finalized'))
        AND ("profile_freeze"."finalized_at" IS NOT NULL) = ("profile_freeze"."phase" = 'finalized'))
);
--> statement-breakpoint
INSERT INTO "profile_freeze" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- What the CHECKs cannot say, because they see only the row after the change:
-- the phase only moves forward (certified may step back to open, the reader
-- revert, and only that), nothing returns once cleanup has started, the
-- generation never falls, and the row cannot be deleted or truncated. A row
-- that is gone would read as "no freeze".
CREATE OR REPLACE FUNCTION "profile_freeze_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_rank integer;
  new_rank integer;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'profile_freeze cannot be deleted or truncated'
      USING ERRCODE = 'check_violation';
  END IF;
  old_rank := CASE OLD.phase WHEN 'open' THEN 0 WHEN 'certified' THEN 1 WHEN 'cleanup_started' THEN 2 ELSE 3 END;
  new_rank := CASE NEW.phase WHEN 'open' THEN 0 WHEN 'certified' THEN 1 WHEN 'cleanup_started' THEN 2 ELSE 3 END;
  IF NEW.reconcile_generation < OLD.reconcile_generation THEN
    RAISE EXCEPTION 'profile_freeze generation cannot fall'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A freeze or an unfreeze opens a new window: exactly one generation up and
  -- no pass carried over. Nothing else moves the generation. Without this a
  -- pass for window g could be replayed on a later window that is also g.
  IF NEW.writes_frozen IS DISTINCT FROM OLD.writes_frozen THEN
    IF OLD.phase <> 'open' OR NEW.phase <> 'open'
       OR NEW.reconcile_generation <> OLD.reconcile_generation + 1
       OR NEW.certified_generation IS NOT NULL THEN
      RAISE EXCEPTION 'profile_freeze freeze or unfreeze must open a new generation in phase open'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.reconcile_generation <> OLD.reconcile_generation THEN
    RAISE EXCEPTION 'profile_freeze generation moves only with a freeze or unfreeze'
      USING ERRCODE = 'check_violation';
  END IF;
  IF new_rank > old_rank + 1 THEN
    RAISE EXCEPTION 'profile_freeze phase cannot skip from % to %', OLD.phase, NEW.phase
      USING ERRCODE = 'check_violation';
  END IF;
  IF new_rank < old_rank AND NOT (OLD.phase = 'certified' AND NEW.phase = 'open') THEN
    RAISE EXCEPTION 'profile_freeze phase cannot move back from % to %', OLD.phase, NEW.phase
      USING ERRCODE = 'check_violation';
  END IF;
  -- The reader revert leaves the freeze and the window as they are.
  IF OLD.phase = 'certified' AND (
       NOT NEW.writes_frozen
       OR NEW.reconcile_generation <> OLD.reconcile_generation) THEN
    RAISE EXCEPTION 'profile_freeze stays frozen while certified'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.phase IN ('cleanup_started', 'finalized') AND (
       NOT NEW.writes_frozen
       OR NEW.reconcile_generation <> OLD.reconcile_generation
       OR NEW.certified_generation IS DISTINCT FROM OLD.certified_generation
       OR NEW.cleanup_started_at IS DISTINCT FROM OLD.cleanup_started_at
       OR (OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at)) THEN
    RAISE EXCEPTION 'profile_freeze is final once cleanup has started'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "profile_freeze_update_guard" BEFORE UPDATE ON "profile_freeze"
  FOR EACH ROW EXECUTE FUNCTION "profile_freeze_guard"();--> statement-breakpoint
CREATE TRIGGER "profile_freeze_delete_guard" BEFORE DELETE ON "profile_freeze"
  FOR EACH ROW EXECUTE FUNCTION "profile_freeze_guard"();--> statement-breakpoint
CREATE TRIGGER "profile_freeze_truncate_guard" BEFORE TRUNCATE ON "profile_freeze"
  FOR EACH STATEMENT EXECUTE FUNCTION "profile_freeze_guard"();
