-- Once session_pin_cutover.authoritative is true, a live session must carry a
-- complete spec pin: a release, a pin, and a pin on the session's own model.
-- The trigger fires only for a row that breaks that, so a normal write costs
-- nothing. It takes the cutover lock shared, then reads the flag in a statement
-- of its own: the flip holds the lock exclusively while it reads the gate, so a
-- write is either committed before the gate is read or sees the flag on. A
-- snapshot that predates the lock would read the flag as it was, so only a
-- read committed transaction may write such a row.
--
-- The condition is structural: whether a pin verifies (its digests) is not
-- computable here. The only writers of the pin columns build it with
-- sessionPinFromRelease, which verifies the release's spec; the pin gate still
-- counts an unverifiable pin before the flag is turned on.
CREATE OR REPLACE FUNCTION "sessions_pin_required"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a live session without a spec pin is written in a read committed transaction'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('session_pin_cutover', 0));
  IF (SELECT "authoritative" FROM "session_pin_cutover" WHERE "id" = 1) THEN
    RAISE EXCEPTION 'session_pin_required: a live session needs a release and a spec pin on its own model'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "sessions_pin_required_insert" ON "sessions";--> statement-breakpoint
CREATE TRIGGER "sessions_pin_required_insert" BEFORE INSERT ON "sessions"
  FOR EACH ROW WHEN (
    NEW."status" NOT IN ('failed', 'stopped')
    AND (NEW."agent_release_id" IS NULL OR NEW."runtime_spec" IS NULL
         OR NEW."runtime_spec" ->> 'model' IS DISTINCT FROM NEW."model")
  ) EXECUTE FUNCTION "sessions_pin_required"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "sessions_pin_required_update" ON "sessions";--> statement-breakpoint
CREATE TRIGGER "sessions_pin_required_update" BEFORE UPDATE OF
  "status", "model", "agent_release_id", "runtime_spec", "spec_source", "spec_source_digest", "spec_digest"
  ON "sessions"
  FOR EACH ROW WHEN (
    NEW."status" NOT IN ('failed', 'stopped')
    AND (NEW."agent_release_id" IS NULL OR NEW."runtime_spec" IS NULL
         OR NEW."runtime_spec" ->> 'model' IS DISTINCT FROM NEW."model")
  ) EXECUTE FUNCTION "sessions_pin_required"();
