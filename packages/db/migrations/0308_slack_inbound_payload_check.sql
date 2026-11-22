-- migrate:no-transaction
-- Lets a processed or failed row lose its payload: the old CHECK held every
-- row but a dropped one to have it. Received rows still must, dropped rows
-- still must not. The new CHECK only loosens the old one, so writes of the
-- image before this one pass it.
--
-- slack_inbound_events only grows, so the CHECK is added NOT VALID and
-- validated in its own statement, and the index is built CONCURRENTLY: no
-- step holds a write lock for a scan. Every statement may run again, so a
-- failure part way leaves the ones before it committed and the next run starts
-- from the top; a build cut short leaves an invalid index, which the DROP
-- removes before the next try.
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_payload_check", ADD CONSTRAINT "slack_inbound_events_payload_check" CHECK (("slack_inbound_events"."status" = 'dropped') = ("slack_inbound_events"."drop_reason" IS NOT NULL) AND ("slack_inbound_events"."status" <> 'received' OR "slack_inbound_events"."payload" IS NOT NULL) AND ("slack_inbound_events"."status" <> 'dropped' OR "slack_inbound_events"."payload" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" VALIDATE CONSTRAINT "slack_inbound_events_payload_check";--> statement-breakpoint
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_dropped_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "slack_inbound_events_failed_payload_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "slack_inbound_events_failed_payload_idx" ON "slack_inbound_events" USING btree ("received_at") WHERE "slack_inbound_events"."status" = 'failed' AND "slack_inbound_events"."payload" IS NOT NULL;
