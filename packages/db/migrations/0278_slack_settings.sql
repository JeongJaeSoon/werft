-- Where Slack's event requests enter, for the whole installation, saved by an
-- owner in the console. No row until one is saved, or until the first start
-- of this release carries the old SLACK_EVENTS_PUBLIC_URL in.
--
-- The previous release reads none of this, so it runs on the migrated
-- database with its env as before. Keep the table when going back: the next
-- upgrade then finds the row and carries nothing in again.
CREATE TABLE "slack_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"events_public_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_settings_single_row_check" CHECK ("slack_settings"."id")
);
