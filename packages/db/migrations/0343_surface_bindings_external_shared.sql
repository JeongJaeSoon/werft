-- Whether Slack last said another organization shares a bound channel, and
-- as of when. A constant default and a nullable column, so no row is
-- rewritten; the statements may run again.
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "external_shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "external_shared_at" timestamp with time zone;
