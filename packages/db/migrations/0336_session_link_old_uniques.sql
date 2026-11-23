-- migrate:no-transaction
-- Drops the two uniques from before session_links kept closed links as
-- history, leaving only the open-only pair from 0313, so a thread or a
-- session may hold one open link beside its closed ones. Every host in the
-- support window reserves through the open-only uniques (94S-2021). The
-- constraint goes in one statement that scans nothing; the index is dropped
-- concurrently. No row is updated. Every statement may run again.
ALTER TABLE "session_links" DROP CONSTRAINT IF EXISTS "session_links_surface_ref_key";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "session_links_session_uniq";
