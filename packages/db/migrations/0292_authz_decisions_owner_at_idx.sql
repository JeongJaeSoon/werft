-- migrate:no-transaction
-- The owner's audit list reads one workspace's decision rows newest first;
-- the (at) index alone walks every workspace's recent rows to find them.
--
-- authz_decisions is written on every managing request, so the index is
-- built CONCURRENTLY. Both statements may run again: a build cut short
-- leaves an invalid index, which the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "authz_decisions_owner_at_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "authz_decisions_owner_at_idx" ON "authz_decisions" USING btree ("owner_id","at");
