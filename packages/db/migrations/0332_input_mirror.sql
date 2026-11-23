-- migrate:no-transaction
-- Adds the `input_mirror` outbox kind: a web input shown in Slack, with no
-- session. `input_id` names that input; set on such a row alone. Its post's
-- ts becomes the input's Slack alias, and its topic's when the topic had
-- none. slack_outbox only grows, so each constraint is added NOT VALID and
-- validated in its own statement, whose scan holds no write lock; the
-- partial index the outbox walks for the inputs still owed a mirror is
-- built concurrently. Every statement may run again.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "input_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check", ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice', 'input_mirror')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_input_check", ADD CONSTRAINT "slack_outbox_input_check" CHECK (("slack_outbox"."kind" = 'input_mirror') = ("slack_outbox"."input_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_input_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_input_fk", ADD CONSTRAINT "slack_outbox_input_fk" FOREIGN KEY ("input_id") REFERENCES "public"."conversation_inputs"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_input_fk";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_inputs_mirror_due_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_inputs_mirror_due_idx" ON "conversation_inputs" USING btree ("received_at") WHERE "conversation_inputs"."slack_mirror" = 'pending' AND "conversation_inputs"."slack_ts" IS NULL;
