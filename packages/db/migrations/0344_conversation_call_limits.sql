-- migrate:no-transaction
-- The calls in progress a conversation call's issue counts against its
-- limits: by agent, and by person over every agent. Built concurrently, so
-- no write waits on them. Every statement may run again.
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_agent_open_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_agent_open_idx" ON "conversation_calls" USING btree ("agent_id") WHERE "conversation_calls"."state" IN ('reserved', 'in_flight');--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_requester_open_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_requester_open_idx" ON "conversation_calls" USING btree ("workspace_id","requester_user_id") WHERE "conversation_calls"."state" IN ('reserved', 'in_flight') AND "conversation_calls"."requester_user_id" IS NOT NULL;
