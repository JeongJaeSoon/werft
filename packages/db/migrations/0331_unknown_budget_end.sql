-- migrate:no-transaction
-- Adds unknown_at to budget_reservations and conversation_calls: set when a
-- call the proxy used gets no usage report within its lease. The row stays
-- reserved (a conversation call stays in_flight) and keeps holding its
-- amount until a late report settles it; a renewal or a release clears it.
-- No state value or CHECK changes, so an older image ignores the column and
-- settles or releases the row as before. Nullable with no default, so adding
-- it rewrites nothing. The indexes serve the reconciler's passes; a build a
-- failed run left invalid is dropped first. Every statement may run again.
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "unknown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "unknown_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "budget_reservations_unknown_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "budget_reservations_unknown_idx" ON "budget_reservations" USING btree ("account_id") WHERE "budget_reservations"."state" = 'reserved' AND "budget_reservations"."unknown_at" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_in_flight_started_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_in_flight_started_idx" ON "conversation_calls" USING btree ("started_at") WHERE "conversation_calls"."state" = 'in_flight' AND "conversation_calls"."unknown_at" IS NULL;
