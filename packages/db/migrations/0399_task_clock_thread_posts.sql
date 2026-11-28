-- migrate:no-transaction
-- A task's clock (v1-b/C2) counts the posts people make in its thread, which
-- the inbox keeps after it clears their payloads: from_bot marks a bot's,
-- written as each event is recorded. A nullable column with no default only
-- changes the catalog; no row is rewritten or backfilled, and a row an image
-- before it writes stays null, read as a person's. The index is built
-- concurrently, so writers go on while it scans. Every statement may run again.
ALTER TABLE "slack_inbound_events" ADD COLUMN IF NOT EXISTS "from_bot" boolean;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_inbound_events_thread_received_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_inbound_events_thread_received_idx" ON "slack_inbound_events" USING btree ("conversation_key","received_at") WHERE "slack_inbound_events"."conversation_key" IS NOT NULL AND "slack_inbound_events"."from_bot" IS NOT TRUE;
