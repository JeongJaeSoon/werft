CREATE TABLE "slack_thread_bot_turns" (
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"counted_turns" text[] DEFAULT '{}' NOT NULL,
	"human_ts" text,
	"stop_turn" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_thread_bot_turns_pkey" PRIMARY KEY("workspace_id","team_id","channel_id","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "slack_allowed_bot_user_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_thread_bot_turns" ADD CONSTRAINT "slack_thread_bot_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;