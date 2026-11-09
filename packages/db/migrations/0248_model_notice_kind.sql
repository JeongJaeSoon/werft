-- migrate:no-transaction
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top. The CHECK is added NOT
-- VALID and validated in its own statement, so the scan does not hold the
-- ADD's lock.
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";
