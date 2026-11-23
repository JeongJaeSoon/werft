CREATE TABLE "conversation_engagements" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"ts" text NOT NULL,
	"kind" text NOT NULL,
	"session_id" uuid,
	"conversation_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_engagements_agent_id_team_id_channel_id_ts_pk" PRIMARY KEY("agent_id","team_id","channel_id","ts"),
	CONSTRAINT "conversation_engagements_kind_check" CHECK ("conversation_engagements"."kind" IN ('mention','reply','bound','proactive')),
	CONSTRAINT "conversation_engagements_target_check" CHECK (num_nonnulls("conversation_engagements"."session_id", "conversation_engagements"."conversation_turn_id") = 1),
	CONSTRAINT "conversation_engagements_slack_check" CHECK ("conversation_engagements"."team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_engagements"."channel_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_engagements"."ts" ~ '^[0-9]{1,20}\.[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE "conversation_engagements" ADD CONSTRAINT "conversation_engagements_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_engagements" ADD CONSTRAINT "conversation_engagements_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_engagements_message_idx" ON "conversation_engagements" USING btree ("workspace_id","team_id","channel_id","ts");--> statement-breakpoint
CREATE INDEX "conversation_engagements_session_idx" ON "conversation_engagements" USING btree ("session_id");