CREATE TABLE "conversation_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"slack_team_id" text,
	"slack_channel_id" text,
	"slack_ts" text,
	"requester_kind" text NOT NULL,
	"requester_id" text NOT NULL,
	"turn_id" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_inputs_seq_uniq" UNIQUE("topic_id","seq"),
	CONSTRAINT "conversation_inputs_slack_uniq" UNIQUE("agent_id","slack_team_id","slack_channel_id","slack_ts"),
	CONSTRAINT "conversation_inputs_seq_check" CHECK ("conversation_inputs"."seq" > 0),
	CONSTRAINT "conversation_inputs_slack_check" CHECK (("conversation_inputs"."slack_team_id" IS NULL AND "conversation_inputs"."slack_channel_id" IS NULL AND "conversation_inputs"."slack_ts" IS NULL) OR ("conversation_inputs"."slack_team_id" IS NOT NULL AND "conversation_inputs"."slack_channel_id" IS NOT NULL AND "conversation_inputs"."slack_ts" IS NOT NULL AND "conversation_inputs"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_inputs"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_inputs"."slack_ts" ~ '^[0-9]{1,20}\.[0-9]{1,20}$'))
);
--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD CONSTRAINT "conversation_inputs_topic_id_conversation_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."conversation_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD CONSTRAINT "conversation_inputs_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_inputs_slack_message_idx" ON "conversation_inputs" USING btree ("workspace_id","slack_team_id","slack_channel_id","slack_ts");