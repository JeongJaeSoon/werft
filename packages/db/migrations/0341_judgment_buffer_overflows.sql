-- How many held messages an agent lost per Slack channel to the judgment
-- buffer's limit: counts only, no message or text. A new, empty table, so
-- nothing here rewrites or locks an existing one.
CREATE TABLE "judgment_buffer_overflows" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"dropped_count" bigint NOT NULL,
	"last_dropped_at" timestamp with time zone NOT NULL,
	CONSTRAINT "judgment_buffer_overflows_pk" PRIMARY KEY("agent_id","slack_team_id","slack_channel_id"),
	CONSTRAINT "judgment_buffer_overflows_count_check" CHECK ("judgment_buffer_overflows"."dropped_count" > 0),
	CONSTRAINT "judgment_buffer_overflows_slack_check" CHECK ("judgment_buffer_overflows"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "judgment_buffer_overflows"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "judgment_buffer_overflows" ADD CONSTRAINT "judgment_buffer_overflows_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;