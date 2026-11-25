-- migrate:no-transaction
-- The `conversation_reply` outbox kind: a conversation turn's answer, the
-- effect of its "reply" decision, with no session. `conversation_turn_id`
-- names its turn and is set on such a row alone; the row always goes in a
-- thread (a non-empty `thread_ts`). The column is nullable with no default,
-- so no row is rewritten and an older image goes on writing rows without it.
-- The CHECKs are added NOT VALID and validated in statements of their own, so
-- no scan holds a write lock. Every statement may run again.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "conversation_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice', 'input_mirror', 'channel_notice', 'progress', 'reaction', 'conversation_reply')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_conversation_reply_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_conversation_reply_check" CHECK (("slack_outbox"."kind" = 'conversation_reply') = ("slack_outbox"."conversation_turn_id" IS NOT NULL) AND ("slack_outbox"."kind" <> 'conversation_reply' OR ("slack_outbox"."session_id" IS NULL AND "slack_outbox"."session_link_id" IS NULL AND "slack_outbox"."thread_ts" <> ''))) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_conversation_reply_check";
