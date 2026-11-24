-- When a launch's resource began waiting for room no node has, and the
-- provider's words for it. Nullable columns with no default, so no row is
-- rewritten; the statements may run again.
ALTER TABLE "worker_launches" ADD COLUMN IF NOT EXISTS "capacity_wait_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worker_launches" ADD COLUMN IF NOT EXISTS "capacity_wait_message" text;
