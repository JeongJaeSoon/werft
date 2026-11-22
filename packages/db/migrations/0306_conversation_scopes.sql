CREATE TABLE "channel_contexts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_contexts_channel_uniq" UNIQUE("workspace_id","team_id","channel_id"),
	CONSTRAINT "channel_contexts_ids_check" CHECK ("channel_contexts"."team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "channel_contexts"."channel_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "conversation_topics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slack_team_id" text,
	"slack_channel_id" text,
	"slack_thread_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_topics_slack_uniq" UNIQUE("agent_id","slack_team_id","slack_channel_id","slack_thread_ts"),
	CONSTRAINT "conversation_topics_slack_check" CHECK (("conversation_topics"."slack_team_id" IS NULL AND "conversation_topics"."slack_channel_id" IS NULL AND "conversation_topics"."slack_thread_ts" IS NULL) OR ("conversation_topics"."slack_team_id" IS NOT NULL AND "conversation_topics"."slack_channel_id" IS NOT NULL AND "conversation_topics"."slack_thread_ts" IS NOT NULL AND "conversation_topics"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_topics"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_topics"."slack_thread_ts" ~ '^[0-9]{1,20}\.[0-9]{1,20}$'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"team_id" text,
	"channel_id" text,
	"person_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_uniq" UNIQUE("agent_id","team_id","channel_id"),
	CONSTRAINT "conversations_dm_uniq" UNIQUE("agent_id","person_user_id"),
	CONSTRAINT "conversations_agent_id_key" UNIQUE("workspace_id","agent_id","id"),
	CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" IN ('channel','dm')),
	CONSTRAINT "conversations_place_check" CHECK (("conversations"."kind" = 'channel' AND "conversations"."team_id" IS NOT NULL AND "conversations"."channel_id" IS NOT NULL AND "conversations"."person_user_id" IS NULL) OR ("conversations"."kind" = 'dm' AND "conversations"."person_user_id" IS NOT NULL AND "conversations"."team_id" IS NULL AND "conversations"."channel_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "channel_contexts" ADD CONSTRAINT "channel_contexts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_topics" ADD CONSTRAINT "conversation_topics_conversation_fk" FOREIGN KEY ("workspace_id","agent_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_fk" FOREIGN KEY ("workspace_id","team_id","channel_id") REFERENCES "public"."channel_contexts"("workspace_id","team_id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_person_fk" FOREIGN KEY ("workspace_id","person_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_topics_conversation_idx" ON "conversation_topics" USING btree ("conversation_id");