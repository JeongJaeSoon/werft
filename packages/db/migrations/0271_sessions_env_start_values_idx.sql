-- migrate:no-transaction
-- The sessions that still hold a copied variable value. The reconciler's
-- purge (purgeExpiredEnvStart) reads this index every pass instead of the
-- whole table, which only grows; its WHERE repeats this predicate so the
-- planner can prove it. A close or a purge strips the values and the row
-- leaves the index. admission_state stays out of the predicate, so this
-- index puts no HOT restriction of its own on admission_state writes.
--
-- Written by hand and absent from schema.ts: the predicate calls
-- env_start_without_values (0249), and Drizzle declares no functions. The
-- index stores what that function returned when each row was written. A
-- migration that changes what the function returns must rebuild this index.
--
-- sessions is written all the time, so the index is built CONCURRENTLY. Both
-- statements may run again: a build cut short leaves an invalid index, which
-- the DROP removes before the next try.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_env_start_values_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "sessions_env_start_values_idx" ON "sessions" USING btree ("id") WHERE "env_start" IS NOT NULL AND "env_start" IS DISTINCT FROM env_start_without_values("env_start");
