-- Slack threads of mention turns whose status is to be set again from what
-- their turns say: a newer turn's "processing" that an older one's `active`
-- may have overtaken, and a thread a delete of the conversation's records
-- left "processing". The table is new and empty, so its constraints are made
-- with it. Every statement may run again.
CREATE TABLE IF NOT EXISTS "mention_thread_statuses" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_installation_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_thread_statuses_pkey" PRIMARY KEY("agent_id","team_id","channel_id","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "mention_thread_statuses" DROP CONSTRAINT IF EXISTS "mention_thread_statuses_agent_fk", ADD CONSTRAINT "mention_thread_statuses_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_thread_statuses" DROP CONSTRAINT IF EXISTS "mention_thread_statuses_slack_installation_fk", ADD CONSTRAINT "mention_thread_statuses_slack_installation_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;
