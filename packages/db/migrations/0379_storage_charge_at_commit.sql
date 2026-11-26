-- The storage charge moves from each turn insert to the commit of the
-- transaction that made it. Charged at the insert, the one storage_usage row
-- stayed locked until that transaction ended, and admitInput locked it even
-- earlier to check the limit, so every acceptance of the installation waited
-- for the one before it. Charged at commit, the row is locked for the commit
-- alone.
--
-- The limit is checked in the same statement that charges: the acceptance
-- sets werft.storage_limit_bytes for its transaction (admitInput), and the
-- trigger raises SQLSTATE WF001 when the sum it just wrote is past it, which
-- rolls the whole acceptance back. A transaction that does not set it is
-- charged and never refused, as before: the platform's own turns (a push
-- follow-up, a parked turn going on), and an API build from before this
-- migration still serving during a rollout, which checks the limit itself
-- under the row lock it takes.
CREATE OR REPLACE FUNCTION "storage_usage_charge_turn"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  kept bigint;
  -- Empty, not null, on a connection whose earlier transaction set it.
  cap text := current_setting('werft.storage_limit_bytes', true);
BEGIN
  UPDATE "storage_usage"
    SET "bytes" = "bytes" + octet_length(NEW."message"), "updated_at" = now()
    WHERE "scope" = 'installation'
    RETURNING "bytes" INTO kept;
  IF NOT FOUND THEN
    -- No row yet, on a database the 0107 backfill did not seed.
    INSERT INTO "storage_usage" ("scope", "bytes")
    VALUES ('installation', octet_length(NEW."message"))
    ON CONFLICT ("scope") DO UPDATE
      SET "bytes" = "storage_usage"."bytes" + EXCLUDED."bytes", "updated_at" = now()
    RETURNING "bytes" INTO kept;
  END IF;
  IF cap <> '' AND kept > cap::bigint THEN
    RAISE EXCEPTION 'storage limit exceeded: % bytes kept, limit %', kept, cap
      USING ERRCODE = 'WF001';
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
-- In the migration's transaction with the new trigger: dropping it locks out
-- turn inserts until this commits, so none lands uncharged between the two.
DROP TRIGGER "turns_charge_storage" ON "turns";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "turns_charge_storage" AFTER INSERT ON "turns"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "storage_usage_charge_turn"();
