-- migrate:no-transaction
-- Source sets on turns and Slack outbox rows: where each came from, as Slack
-- places and conversation input ids, never text. Null is no source; every row
-- before this migration reads so, and an image from before it writes none.
--
-- Both tables only grow: the columns are nullable with no default, and the
-- indexes are built CONCURRENTLY. Every statement may run again: a failure
-- part way leaves the ones before it committed, and the next run starts from
-- the top.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "sources" jsonb;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN IF NOT EXISTS "sources" jsonb;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_outbox_sources_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_outbox_sources_idx" ON "slack_outbox" USING gin ("sources" jsonb_path_ops) WHERE "slack_outbox"."sources" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "turns_sources_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "turns_sources_idx" ON "turns" USING gin ("sources" jsonb_path_ops) WHERE "turns"."sources" IS NOT NULL;
