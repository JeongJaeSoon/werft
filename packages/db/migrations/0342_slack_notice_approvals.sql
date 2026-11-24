-- Approvals of the Slack notice, one row per agent, Slack team and notice
-- version. A new, empty table: no existing install gets an approval, and no
-- agent's conversation_rollout changes.
CREATE TABLE "slack_notice_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"notice_version" integer NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "slack_notice_approvals_version_check" CHECK ("slack_notice_approvals"."notice_version" >= 1),
	CONSTRAINT "slack_notice_approvals_revoked_check" CHECK (("slack_notice_approvals"."revoked_at" IS NULL) = ("slack_notice_approvals"."revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_notice_approvals" ADD CONSTRAINT "slack_notice_approvals_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_notice_approvals_live_uniq" ON "slack_notice_approvals" USING btree ("agent_id","slack_team_id","notice_version") WHERE "slack_notice_approvals"."revoked_at" IS NULL;