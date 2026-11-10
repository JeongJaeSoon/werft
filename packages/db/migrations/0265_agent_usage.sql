CREATE TABLE "agent_usage" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"limits_revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_workspace_agent_uniq" UNIQUE("workspace_id","agent_id"),
	CONSTRAINT "agent_usage_scope_check" CHECK ("agent_usage"."scope" IN ('workspace','private')),
	CONSTRAINT "agent_usage_revision_check" CHECK ("agent_usage"."revision" > 0),
	CONSTRAINT "agent_usage_limits_revision_check" CHECK ("agent_usage"."limits_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_usage_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_usage_targets_one_target_check" CHECK (("agent_usage_targets"."user_id" IS NULL) <> ("agent_usage_targets"."team_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_targets" ADD CONSTRAINT "agent_usage_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_targets" ADD CONSTRAINT "agent_usage_targets_usage_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agent_usage"("workspace_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_targets" ADD CONSTRAINT "agent_usage_targets_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."member_teams"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage_targets" ADD CONSTRAINT "agent_usage_targets_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_usage_targets_team_uniq" ON "agent_usage_targets" USING btree ("agent_id","team_id") WHERE "agent_usage_targets"."team_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_usage_targets_user_uniq" ON "agent_usage_targets" USING btree ("agent_id","user_id") WHERE "agent_usage_targets"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_usage_targets_team_idx" ON "agent_usage_targets" USING btree ("team_id");--> statement-breakpoint
-- Every agent that exists now is usable by the whole workspace, as before.
INSERT INTO "agent_usage" ("agent_id", "workspace_id") SELECT "id", "workspace_id" FROM "agents" ON CONFLICT DO NOTHING;