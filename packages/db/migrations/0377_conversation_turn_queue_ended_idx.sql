-- migrate:no-transaction
-- Every turn queue call first forgets the turns that ended ten minutes ago
-- (state = 'ended' AND ended_at <= a time). No index leads with that, so each
-- call read every row the queue ever held. This one holds only the ended
-- turns not forgotten yet.
--
-- conversation_turn_queue is written on every conversation turn, so the index
-- is built CONCURRENTLY. Both statements may run again: a build cut short
-- leaves an invalid index, which the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "conversation_turn_queue_ended_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_turn_queue_ended_idx" ON "conversation_turn_queue" USING btree ("ended_at") WHERE "conversation_turn_queue"."state" = 'ended';