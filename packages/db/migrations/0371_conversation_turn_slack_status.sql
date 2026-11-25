-- migrate:no-transaction
-- When a mention's conversation turn set its Slack thread back from
-- "processing": the Slack role's step that ends those turns marks it once, so
-- the thread is told `active` once. conversation_turns gains a nullable
-- column with no default, which rewrites no row, and a partial index of the
-- turns still due, built concurrently after any failed build of it is
-- dropped. Every statement may run again.
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "slack_status_reset_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_turns_slack_status_due_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_turns_slack_status_due_idx" ON "conversation_turns" USING btree ("created_at") WHERE "conversation_turns"."slack_status_reset_at" IS NULL AND "conversation_turns"."slack_installation_id" IS NOT NULL AND "conversation_turns"."origin" = 'm2';
