-- migrate:no-transaction
-- What an engine says on its own after a turn ends is stored on that turn
-- with `after_turn` in `neutral`, and each such answer ends with a `result`
-- event. The Slack outbox posts one follow-up per such result, so each pass
-- looks for them in every live linked session; with only (session_id, id) to
-- go by, it would read each session's whole history. This index holds those
-- results alone: a handful per session. A link closed within a day still
-- takes the follow-ups of answers stored before it closed; the second index
-- finds those links by when they closed, without reading every closed one.
--
-- Both tables are written all the time, so the indexes are built
-- CONCURRENTLY. Each statement may run again: a build cut short leaves an invalid index, which
-- the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "events_after_turn_result_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "events_after_turn_result_idx" ON "events" USING btree ("session_id","id") WHERE "events"."type" = 'result' AND ("events"."neutral" ->> 'after_turn') IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_links_recent_closed_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "session_links_recent_closed_idx" ON "session_links" USING btree ("closed_at") WHERE "session_links"."closed_at" IS NOT NULL;
