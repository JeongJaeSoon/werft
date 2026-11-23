-- migrate:no-transaction
-- Holds a Slack row bound for a web input's mirror thread until the mirror's
-- post is known, and gives each mirror post its own correlation id, sent as
-- message metadata. A web input's Slack mirror may now be `unconfirmed`.
-- Both tables only grow, so each constraint is swapped in one statement,
-- added NOT VALID and validated in its own statement, whose scan holds no
-- write lock; the partial indexes are built concurrently. No row is
-- updated. Every statement may run again.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "held_for_input_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_origin_check", ADD CONSTRAINT "conversation_inputs_origin_check" CHECK (("conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."body" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NOT NULL AND "conversation_inputs"."buffer_expires_at" IS NULL) OR ("conversation_inputs"."client_message_id" IS NOT NULL AND "conversation_inputs"."client_message_id" ~ '^[A-Za-z0-9_-]{1,128}$' AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'user' AND "conversation_inputs"."slack_mirror" IS NOT NULL AND "conversation_inputs"."slack_mirror" IN ('not_target','pending','unconfirmed') AND "conversation_inputs"."buffer_expires_at" IS NULL) OR ("conversation_inputs"."buffer_expires_at" IS NOT NULL AND "conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NULL AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."slack_ts" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'slack_user')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_origin_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_correlation_check", ADD CONSTRAINT "slack_outbox_correlation_check" CHECK (("slack_outbox"."correlation_id" IS NULL OR "slack_outbox"."kind" = 'input_mirror') AND ("slack_outbox"."held_for_input_id" IS NULL OR "slack_outbox"."kind" <> 'input_mirror')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_correlation_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_held_for_input_fk", ADD CONSTRAINT "slack_outbox_held_for_input_fk" FOREIGN KEY ("held_for_input_id") REFERENCES "public"."conversation_inputs"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_held_for_input_fk";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_outbox_held_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_outbox_held_idx" ON "slack_outbox" USING btree ("held_for_input_id") WHERE "slack_outbox"."held_for_input_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_outbox_correlation_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_outbox_correlation_idx" ON "slack_outbox" USING btree ("correlation_id") WHERE "slack_outbox"."correlation_id" IS NOT NULL AND "slack_outbox"."status" IN ('sending', 'uncertain');
