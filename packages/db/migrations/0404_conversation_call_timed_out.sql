-- migrate:no-transaction
-- A conversation call of no turn that its caller gave up on, or that stayed
-- in flight past the provider exchange lease, becomes `timed_out`: out of
-- the call limits' count, its reservation held as of unknown end. Only the
-- state's two CHECKs change; no row is rewritten. Each is dropped and added
-- again NOT VALID in one statement, then validated in its own, whose scan
-- holds no write lock; every existing row passes, as none is timed out. An
-- older image writes no such row and counts none under its limits. Every
-- statement may run again.
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_state_check", ADD CONSTRAINT "conversation_calls_state_check" CHECK ("conversation_calls"."state" IN ('reserved','in_flight','settled','released','resolved','timed_out')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_state_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_state_columns_check", ADD CONSTRAINT "conversation_calls_state_columns_check" CHECK (CASE "conversation_calls"."state"
        WHEN 'reserved' THEN "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'in_flight' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'settled' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NOT NULL
        WHEN 'resolved' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'timed_out' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
        ELSE "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
      END) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_state_columns_check";
