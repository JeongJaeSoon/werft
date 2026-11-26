-- migrate:no-transaction
-- An owner's sessions by parent conversation. Every list, count and usage
-- read asks which private channels the owner's sessions come from
-- (privateChannels); this index lets it walk the distinct parents one probe
-- each instead of reading every session of the owner.
--
-- sessions is written all the time, so the index is built CONCURRENTLY. Both
-- statements may run again: a build cut short leaves an invalid index, which
-- the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_owner_parent_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "sessions_owner_parent_idx" ON "sessions" USING btree ("owner_id","parent_conversation_id") WHERE "sessions"."parent_conversation_id" IS NOT NULL;
