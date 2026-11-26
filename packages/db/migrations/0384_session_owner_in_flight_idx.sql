-- migrate:no-transaction
-- A workspace's running and needs_input sessions, newest first. The list
-- filtered to those and the agent cards' in-flight tally had no index but
-- owner_id, so each read every session the workspace ever had to find the few
-- still in flight. Read backward, this one gives the lists' created_at DESC,
-- id DESC order.
--
-- sessions is written on every turn, so the index is built CONCURRENTLY. Both
-- statements may run again: a build cut short leaves an invalid index, which
-- the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_owner_in_flight_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "sessions_owner_in_flight_idx" ON "sessions" USING btree ("owner_id","created_at","id") WHERE "sessions"."status" IN ('running', 'needs_input');
