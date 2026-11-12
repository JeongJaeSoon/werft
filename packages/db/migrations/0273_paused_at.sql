ALTER TABLE "sessions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
-- Sessions already paused start their workspace TTL at the upgrade, so no
-- volume is reclaimed the moment it lands.
UPDATE "sessions" SET "paused_at" = statement_timestamp() WHERE "admission_state" = 'paused';--> statement-breakpoint
-- Set whichever write pauses the session and cleared whichever moves it on,
-- so a new path cannot leave a stale or missing clock.
CREATE FUNCTION "sessions_track_paused_at"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."admission_state" = 'paused' THEN
    NEW."paused_at" := statement_timestamp();
  ELSE
    NEW."paused_at" := NULL;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_track_paused_at" BEFORE UPDATE ON "sessions"
  FOR EACH ROW WHEN (OLD."admission_state" IS DISTINCT FROM NEW."admission_state")
  EXECUTE FUNCTION "sessions_track_paused_at"();
