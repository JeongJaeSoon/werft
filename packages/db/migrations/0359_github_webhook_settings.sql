-- Where GitHub's App webhooks enter, for the whole installation, saved by an
-- owner in the console. No row until one is saved, or until the first start
-- of this release carries the old GITHUB_WEBHOOK_BASE_URL in.
--
-- The previous release reads none of this, so it runs on the migrated
-- database with its env as before. Keep the table when going back: the next
-- upgrade then finds the row and carries nothing in again.
CREATE TABLE "github_webhook_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"public_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_webhook_settings_single_row_check" CHECK ("github_webhook_settings"."id")
);
