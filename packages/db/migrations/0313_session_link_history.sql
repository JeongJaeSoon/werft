-- migrate:no-transaction
-- Session link history, step 1 of 4: a link can close and stay as the
-- thread's history, and an outbox row can name the link it reports to.
-- Nothing writes the new columns yet; every row stays open (closed_at null),
-- so the old uniques and the old ON CONFLICT targets keep working, and an
-- image from before this migration runs on it unchanged. The open-only
-- uniques come beside the old ones, which a later migration drops.
--
-- Both tables only grow: constraints are added NOT VALID and validated in a
-- statement of their own, indexes are built CONCURRENTLY. Every statement
-- may run again: a failure part way leaves the ones before it committed, and
-- the next run starts from the top.
ALTER TABLE "session_links" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN IF NOT EXISTS "closed_reason" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_links_closed_check'
      AND conrelid = '"session_links"'::regclass
  ) THEN
    ALTER TABLE "session_links" ADD CONSTRAINT "session_links_closed_check" CHECK (("session_links"."closed_at" IS NULL) = ("session_links"."closed_reason" IS NULL)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "session_links" VALIDATE CONSTRAINT "session_links_closed_check";--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_links_closed_reason_check'
      AND conrelid = '"session_links"'::regclass
  ) THEN
    ALTER TABLE "session_links" ADD CONSTRAINT "session_links_closed_reason_check" CHECK ("session_links"."closed_reason" IN ('completed', 'cancelled', 'failed', 'abandoned')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "session_links" VALIDATE CONSTRAINT "session_links_closed_reason_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_links_open_surface_ref_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "session_links_open_surface_ref_uniq" ON "session_links" USING btree ("installation_id","surface_ref") WHERE "session_links"."closed_at" IS NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_links_open_session_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "session_links_open_session_uniq" ON "session_links" USING btree ("session_id") WHERE "session_links"."session_id" IS NOT NULL AND "session_links"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "session_link_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'slack_outbox_session_link_fk'
      AND conrelid = '"slack_outbox"'::regclass
  ) THEN
    ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_session_link_fk" FOREIGN KEY ("session_link_id") REFERENCES "public"."session_links"("id") ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_session_link_fk";
