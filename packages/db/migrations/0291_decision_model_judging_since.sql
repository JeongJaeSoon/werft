ALTER TABLE "provider_connections" ADD COLUMN "judging_since" timestamp with time zone;--> statement-breakpoint
-- A decision model already in use starts its window here: what earlier
-- judgments counted stays, and older evidence is not judged again.
UPDATE "provider_connections" SET "judging_since" = now()
WHERE "definition" ->> 'kind' = 'openai_decisions' AND "disabled_at" IS NULL;--> statement-breakpoint
-- A decision model created or enabled again joins the window of the ones
-- still enabled; with none, the window starts now. Every write that creates
-- or enables a connection holds the catalog lock (lockCatalogWrites), so
-- two of them never both see none. clock_timestamp(), not now(): the
-- transaction's start may be before that lock was granted, and evidence
-- from while it waited is not the new window's.
CREATE OR REPLACE FUNCTION "provider_connections_judging_since"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."disabled_at" IS NULL THEN
    RETURN NEW;
  END IF;
  NEW."judging_since" := COALESCE(
    (SELECT min(pc."judging_since") FROM "provider_connections" pc
     WHERE pc."definition" ->> 'kind' = 'openai_decisions'
       AND pc."disabled_at" IS NULL
       AND pc."id" <> NEW."id"),
    clock_timestamp());
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "provider_connections_judging_since" BEFORE INSERT OR UPDATE OF "disabled_at" ON "provider_connections" FOR EACH ROW WHEN (NEW."definition" ->> 'kind' = 'openai_decisions' AND NEW."disabled_at" IS NULL) EXECUTE FUNCTION "provider_connections_judging_since"();
