-- migrate:no-transaction
-- The live sessions a login method made. Turning a provider off ends them
-- (disableLoginProvider), and reads this index instead of every session.
--
-- web_sessions is written on every sign-in, so the index is built
-- CONCURRENTLY. Both statements may run again: a build cut short leaves an
-- invalid index, which the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "web_sessions_login_method_live_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "web_sessions_login_method_live_idx" ON "web_sessions" USING btree ("login_method_id") WHERE "web_sessions"."revoked_at" IS NULL;
