-- Temporary cache for the Slack channel member check: member ids and read
-- times only, 5 minutes. Rows are disposable; the reconciler purges old ones.
CREATE TABLE "slack_channel_member_cache" (
	"installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"member_ids" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "slack_channel_member_cache_pk" PRIMARY KEY("installation_id","channel_id"),
	CONSTRAINT "slack_channel_member_cache_size_check" CHECK (cardinality("slack_channel_member_cache"."member_ids") <= 10000),
	CONSTRAINT "slack_channel_member_cache_time_check" CHECK ("slack_channel_member_cache"."fetched_at" IS NOT NULL OR "slack_channel_member_cache"."invalidated_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "slack_channel_member_cache" ADD CONSTRAINT "slack_channel_member_cache_installation_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "slack_channel_member_cache" IS 'Temporary cache for the channel member check, 5 minutes: Slack user ids and read times only.';
