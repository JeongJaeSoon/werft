-- migrate:no-transaction
-- What an engine says on its own after a turn ends is stored on that turn
-- with `after_turn` in `neutral`, and each such answer ends with a `result`
-- event. The Slack outbox posts one follow-up per such result, so each pass
-- looks for them in every live linked session; with only (session_id, id) to
-- go by, it would read each session's whole history. This index holds those
-- results alone: a handful per session.
--
-- events is written on every turn, so the index is built CONCURRENTLY. Both
-- statements may run again: a build cut short leaves an invalid index, which
-- the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "events_after_turn_result_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "events_after_turn_result_idx" ON "events" USING btree ("session_id","id") WHERE "events"."type" = 'result' AND ("events"."neutral" ->> 'after_turn') IS NOT NULL;
