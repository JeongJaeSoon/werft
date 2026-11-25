-- migrate:no-transaction
-- The `progress` outbox kind: updates of one Slack message edited in place,
-- the rows of one message sharing a `progress_key`, each update keeping the
-- ts of the post it edited in `progress_ts`. The columns are nullable with no
-- default, so no row is rewritten and an older image goes on writing rows
-- without them. The CHECKs are added NOT VALID and validated in statements of
-- their own, and the index is built concurrently, so no scan holds a write
-- lock. Every statement may run again.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "progress_key" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "progress_ts" text;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice', 'input_mirror', 'channel_notice', 'progress')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_progress_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_progress_check" CHECK (("slack_outbox"."kind" = 'progress') = ("slack_outbox"."progress_key" IS NOT NULL) AND ("slack_outbox"."progress_ts" IS NULL OR "slack_outbox"."kind" = 'progress')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_progress_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_outbox_progress_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_outbox_progress_idx" ON "slack_outbox" USING btree ("progress_key","seq") WHERE "slack_outbox"."progress_key" IS NOT NULL;
