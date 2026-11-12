ALTER TABLE "sessions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
-- Set whichever write pauses the session and cleared whichever moves it on,
-- so a new path cannot leave a stale or missing clock. A session already
-- paused here is stamped by the first workspace GC pass that sees it.
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
