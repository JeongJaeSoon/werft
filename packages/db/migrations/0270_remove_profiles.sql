-- Removes runtime profiles. What a session runs is the spec its agent release
-- pinned from a provider connection and the card's model; the run rules are
-- the workspace's and the agent's (workspace_engine_settings,
-- agent_engine_settings). The owner chose to drop what profiles left behind
-- rather than migrate it: releases were made against profiles and cannot be
-- re-derived without them, so they, their sessions and everything recorded
-- under those sessions go. Agents, their cards and versions, teams, keys and
-- the installation's settings stay; an agent is released again on a
-- connection before it runs.

-- Session data, all of it hangs off sessions.
TRUNCATE "sessions", "session_model_usage", "session_pre_metering_cost", "tool_calls", "tool_descriptions", "checkpoint_output_objects" CASCADE;--> statement-breakpoint
-- No agent keeps an active release or a pending draft.
ALTER TABLE "agents" DROP CONSTRAINT "agents_active_release_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_draft_check";--> statement-breakpoint
UPDATE "agents" SET "active_release_id" = NULL, "activation_revision" = -1, "draft_version_id" = NULL, "draft_profile_id" = NULL, "draft_model_source" = NULL, "draft_failure" = NULL;--> statement-breakpoint
TRUNCATE "agent_activation_events", "session_links", "agent_releases" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_active_release_fk" FOREIGN KEY ("id","active_release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The profile tables and the gates of the staged removal.
DROP TABLE "profile_rollout_items";--> statement-breakpoint
DROP TABLE "profile_rollouts";--> statement-breakpoint
DROP TABLE "profile_fill";--> statement-breakpoint
DROP TABLE "workspace_profiles";--> statement-breakpoint
DROP TABLE "installation_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "engine_settings_gate";--> statement-breakpoint
-- A live session of a release always carries that release's spec pin on its
-- own model now; the trigger no longer waits on a cutover flag. A session
-- naming no release has nothing to pin and no claim binds it without a spec,
-- so it is left to the claim.
CREATE OR REPLACE FUNCTION "sessions_pin_required"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."agent_release_id" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'session_pin_required: a live session of a release needs a spec pin on its own model'
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
DROP TABLE "session_pin_cutover";--> statement-breakpoint

-- Columns that named a profile.
ALTER TABLE "agent_engine_settings" DROP CONSTRAINT "agent_engine_settings_admin_deny_check";--> statement-breakpoint
ALTER TABLE "agent_engine_settings" DROP COLUMN "admin_deny";--> statement-breakpoint
ALTER TABLE "agent_releases" DROP CONSTRAINT "agent_releases_spec_check";--> statement-breakpoint
ALTER TABLE "agent_releases" DROP COLUMN "runtime_profile_id";--> statement-breakpoint
ALTER TABLE "agent_releases" DROP COLUMN "profile_digest";--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN "connection_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" ALTER COLUMN "runtime_spec" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" ALTER COLUMN "spec_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" ALTER COLUMN "spec_source_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" ALTER COLUMN "spec_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_profile_tracking_check";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_model_source_check";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "profile_tracking";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_source";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "draft_profile_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "draft_model_source";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "draft_connection_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_draft_check" CHECK (("agents"."draft_version_id" IS NULL) = ("agents"."draft_connection_id" IS NULL) AND ("agents"."draft_failure" IS NULL OR "agents"."draft_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "attempts" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "attempts" DROP COLUMN "profile_fingerprint";--> statement-breakpoint
ALTER TABLE "catalog_repositories" DROP COLUMN "profiles";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "checkpoints" DROP COLUMN "profile_fingerprint";--> statement-breakpoint
ALTER TABLE "session_links" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "profile_fingerprint";--> statement-breakpoint
-- Every session runs its spec's tool list; 0264's choice between the
-- profile's list and the release's no longer has a profile side.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_runtime_tools_source_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "runtime_tools_source";
