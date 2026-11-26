-- migrate:no-transaction
-- What an agent's conversation turn list reads. Its m2 turns come newest
-- first, by id among those of one time: a backward scan gives that order and
-- stops at the page's size. Each turn of the page then looks up its thread's
-- open task session. Built concurrently, so no write waits on them. A build
-- a failed run left invalid is dropped first. Every statement may run again.
DROP INDEX CONCURRENTLY IF EXISTS "conversation_turns_agent_page_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_turns_agent_page_idx" ON "conversation_turns" USING btree ("agent_id","created_at","id") WHERE "conversation_turns"."origin" = 'm2';--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_links_open_thread_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "session_links_open_thread_idx" ON "session_links" USING btree ("workspace_id","agent_id","channel_id","thread_id") WHERE "session_links"."session_id" IS NOT NULL AND "session_links"."closed_at" IS NULL AND "session_links"."revoked_at" IS NULL;
