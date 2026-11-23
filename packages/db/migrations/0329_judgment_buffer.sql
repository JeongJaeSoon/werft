-- migrate:no-transaction
-- The judgment buffer in conversation_inputs: an unmentioned Slack message
-- held with its text, no turn and an end time, removed whole by the
-- reconciler when that time passes. Every row before this migration is a
-- Slack or web input, which the new check holds as the old one did, so an
-- image from before it runs on it unchanged.
--
-- The table only grows: the column has no default, the index is built
-- CONCURRENTLY, the check is added NOT VALID and validated in a statement of
-- its own, and no row is changed. Every statement may run again.
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "buffer_expires_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_inputs_buffer_expiry_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_inputs_buffer_expiry_idx" ON "conversation_inputs" USING btree ("buffer_expires_at") WHERE "conversation_inputs"."buffer_expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_origin_check", ADD CONSTRAINT "conversation_inputs_origin_check" CHECK (("conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."body" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NOT NULL AND "conversation_inputs"."buffer_expires_at" IS NULL) OR ("conversation_inputs"."client_message_id" IS NOT NULL AND "conversation_inputs"."client_message_id" ~ '^[A-Za-z0-9_-]{1,128}$' AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'user' AND "conversation_inputs"."slack_mirror" IS NOT NULL AND "conversation_inputs"."slack_mirror" IN ('not_target','pending') AND "conversation_inputs"."buffer_expires_at" IS NULL) OR ("conversation_inputs"."buffer_expires_at" IS NOT NULL AND "conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NULL AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."slack_ts" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'slack_user')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_origin_check";
