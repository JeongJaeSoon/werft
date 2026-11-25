-- migrate:no-transaction
-- The `reaction` outbox kind: the one reaction the agent puts on a message.
-- No column is added and no row is rewritten. The CHECK is added NOT VALID
-- and validated in a statement of its own, so no scan holds a write lock.
-- Every statement may run again.
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice', 'input_mirror', 'channel_notice', 'progress', 'reaction')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";
