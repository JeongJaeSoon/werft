-- migrate:no-transaction
-- A conversation call records what priced it (priced_by): the rates of its
-- model while it is held, what settled it once reported. The tokens of the
-- calls marked 'unknown' (no amount, so no cost limit counts them) are what
-- the limit on tokens of unknown price counts for the budget account the
-- call was held on, or for its agent when it was held on none, in the month
-- it fell in.
--
-- A nullable column with no default, so no row is rewritten. An older image
-- names its columns when it writes and reads: its rows have priced_by null,
-- read as priced. The CHECK is added NOT VALID and validated in a statement
-- of its own, so no scan holds a write lock. The index holds only the calls
-- marked unknown and is built CONCURRENTLY: conversation_calls is written on
-- every call. Every statement may run again.
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "priced_by" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_priced_by_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD CONSTRAINT "conversation_calls_priced_by_check" CHECK ("conversation_calls"."priced_by" IN ('table', 'litellm', 'unknown', 'unmetered')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_priced_by_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_price_unknown_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_price_unknown_idx" ON "conversation_calls" USING btree ("created_at") WHERE "conversation_calls"."priced_by" = 'unknown';
