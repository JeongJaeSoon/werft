-- When a request signed by each Slack app last arrived. Nullable with no
-- default, so no row is rewritten; the statement may run again.
ALTER TABLE "slack_apps" ADD COLUMN IF NOT EXISTS "events_received_at" timestamp with time zone;
