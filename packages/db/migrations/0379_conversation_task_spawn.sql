-- migrate:no-transaction
-- A mention turn's spawn_task (v1-b/E3): the model's draft of the task, the
-- Slack subject the mention was judged on (task.spawn is judged again on it
-- when the turn ends), and what that end made of it, once. The queue keeps a
-- leased turn's input sealed (its token is not), and a spawn_task turn's
-- past its end until its task is settled; any copy is let go at
-- input_kept_until, so a turn an older image ends is cleared all the same.
-- Nullable columns, no row rewritten; an older image neither reads nor writes
-- them. The CHECKs are added NOT VALID and validated in statements of their
-- own, so no scan holds a write lock. Every statement may run again.
ALTER TABLE "conversation_turn_queue" ADD COLUMN IF NOT EXISTS "input_kept_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "task_draft" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "slack_subject" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "task_effect" text;--> statement-breakpoint
ALTER TABLE "conversation_turn_queue" DROP CONSTRAINT IF EXISTS "conversation_turn_queue_state_check";--> statement-breakpoint
ALTER TABLE "conversation_turn_queue" ADD CONSTRAINT "conversation_turn_queue_state_check" CHECK ("conversation_turn_queue"."attempt" >= 1 AND "conversation_turn_queue"."take_ms" >= 0 AND CASE "conversation_turn_queue"."state"
        WHEN 'queued' THEN "conversation_turn_queue"."turn_nonce" IS NOT NULL AND "conversation_turn_queue"."turn_ciphertext" IS NOT NULL AND "conversation_turn_queue"."lease_id" IS NULL AND "conversation_turn_queue"."runtime_id" IS NULL AND "conversation_turn_queue"."lease_expires_at" IS NULL AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NULL
        WHEN 'leased' THEN ("conversation_turn_queue"."turn_nonce" IS NULL) = ("conversation_turn_queue"."turn_ciphertext" IS NULL) AND ("conversation_turn_queue"."turn_nonce" IS NULL OR "conversation_turn_queue"."input_kept_until" IS NOT NULL) AND "conversation_turn_queue"."lease_id" IS NOT NULL AND "conversation_turn_queue"."runtime_id" IS NOT NULL AND "conversation_turn_queue"."lease_expires_at" IS NOT NULL AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NULL
        WHEN 'ended' THEN ("conversation_turn_queue"."turn_nonce" IS NULL) = ("conversation_turn_queue"."turn_ciphertext" IS NULL) AND ("conversation_turn_queue"."turn_nonce" IS NULL OR "conversation_turn_queue"."input_kept_until" IS NOT NULL) AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."runtime_id" IS NULL) AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."lease_expires_at" IS NULL) AND "conversation_turn_queue"."outcome" IS NOT NULL AND "conversation_turn_queue"."ended_at" IS NOT NULL
        WHEN 'forgotten' THEN ("conversation_turn_queue"."turn_nonce" IS NULL) = ("conversation_turn_queue"."turn_ciphertext" IS NULL) AND ("conversation_turn_queue"."turn_nonce" IS NULL OR "conversation_turn_queue"."input_kept_until" IS NOT NULL) AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."runtime_id" IS NULL) AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."lease_expires_at" IS NULL) AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NOT NULL
        ELSE false
      END) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_turn_queue" VALIDATE CONSTRAINT "conversation_turn_queue_state_check";--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_task_check";--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_task_check" CHECK (("conversation_turns"."task_draft" IS NULL OR "conversation_turns"."decision" = 'spawn_task') AND ("conversation_turns"."task_effect" IS NULL OR ("conversation_turns"."decision" = 'spawn_task' AND "conversation_turns"."task_effect" IN ('opened','refused','failed','voided')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_turns" VALIDATE CONSTRAINT "conversation_turns_task_check";
