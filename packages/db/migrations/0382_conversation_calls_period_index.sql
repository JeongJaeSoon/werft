-- migrate:no-transaction
-- The usage reads take the conversation calls of a period, released ones
-- aside: an installation's over every workspace, so the index leads with
-- created_at. Built concurrently, so no write waits on it. A build a failed
-- run left invalid is dropped first. Every statement may run again.
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_period_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_period_idx" ON "conversation_calls" USING btree ("created_at") WHERE "conversation_calls"."state" <> 'released';
