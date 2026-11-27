-- migrate:no-transaction
-- A thread's closed links, which a stop word's message read again after its
-- link closed looks through for the stop it already made. Built
-- concurrently, so no write waits on it. A build a failed run left invalid
-- is dropped first. Every statement may run again.
DROP INDEX CONCURRENTLY IF EXISTS "session_links_closed_surface_ref_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "session_links_closed_surface_ref_idx" ON "session_links" USING btree ("installation_id","surface_ref") WHERE "session_links"."closed_at" IS NOT NULL;
