CREATE TABLE "agent_caller_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"team_id" uuid,
	"channel_id" text,
	"user_id" uuid,
	"tools_deny" text[] DEFAULT '{}' NOT NULL,
	"repositories" text[],
	"mcp_servers" text[],
	"credentials_deny" text[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_caller_limits_target_uniq" UNIQUE NULLS NOT DISTINCT("agent_id","target_kind","team_id","channel_id","user_id"),
	CONSTRAINT "agent_caller_limits_target_check" CHECK (("agent_caller_limits"."target_kind" = 'workspace' AND "agent_caller_limits"."team_id" IS NULL AND "agent_caller_limits"."channel_id" IS NULL AND "agent_caller_limits"."user_id" IS NULL)
        OR ("agent_caller_limits"."target_kind" = 'team' AND "agent_caller_limits"."team_id" IS NOT NULL AND "agent_caller_limits"."channel_id" IS NULL AND "agent_caller_limits"."user_id" IS NULL)
        OR ("agent_caller_limits"."target_kind" = 'channel' AND "agent_caller_limits"."team_id" IS NULL AND "agent_caller_limits"."channel_id" IS NOT NULL AND "agent_caller_limits"."user_id" IS NULL)
        OR ("agent_caller_limits"."target_kind" = 'user' AND "agent_caller_limits"."team_id" IS NULL AND "agent_caller_limits"."channel_id" IS NULL AND "agent_caller_limits"."user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_caller_limits" ADD CONSTRAINT "agent_caller_limits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_caller_limits" ADD CONSTRAINT "agent_caller_limits_usage_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent_usage"("workspace_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_caller_limits" ADD CONSTRAINT "agent_caller_limits_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_caller_limits" ADD CONSTRAINT "agent_caller_limits_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_caller_limits_team_idx" ON "agent_caller_limits" USING btree ("team_id");