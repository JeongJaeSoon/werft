-- Removes runtime profiles. What a session runs is the spec its agent release
-- pinned from a provider connection and the card's model; the run rules are
-- the workspace's and the agent's (workspace_engine_settings,
-- agent_engine_settings). The owner chose to drop what profiles left behind
-- rather than migrate it: releases were made against profiles and cannot be
-- re-derived without them, so they, their sessions and everything recorded
-- under those sessions go. Agents, their cards and versions, teams, keys and
-- the installation's settings stay; an agent is released again on a
-- connection before it runs.

-- A release takes only a model its connection lists, and 0254 added the
-- list empty. Before the profiles go, each connection still at '[]' gets the
-- models of the profiles that ran on it, so its agents can be released again.
-- A profile belongs to the connection the profile registry gave it: the first
-- live connection by id whose definition is the profile's provider, else the
-- first whose former key (replaces_auth) is, while no live connection holds
-- that provider as its own. A profile counts unless it is blocked, derives
-- from a blocked, missing or circular lineage, or is retired with no agent's
-- active release on it; a workspace profile counts through its base. Models
-- keep the order they were offered in: installation profiles before
-- workspace ones, oldest first, each profile's default before its others.
-- model_families is copied only when every profile that has one agrees.
WITH RECURSIVE
  "in_use" AS (
    SELECT "r"."runtime_profile_id" AS "id"
    FROM "agents" "a"
    JOIN "agent_releases" "r" ON "r"."agent_id" = "a"."id" AND "r"."id" = "a"."active_release_id"
  ),
  "chain" ("id", "cur", "depth") AS (
    SELECT "id", "derived_from", 1 FROM "installation_profiles" WHERE "derived_from" IS NOT NULL
    UNION ALL
    SELECT "c"."id", "p"."derived_from", "c"."depth" + 1
    FROM "chain" "c" JOIN "installation_profiles" "p" ON "p"."id" = "c"."cur"
    WHERE "p"."blocked_at" IS NULL AND "p"."derived_from" IS NOT NULL AND "c"."depth" < 64
  ),
  "broken" AS (
    SELECT "c"."id" FROM "chain" "c" LEFT JOIN "installation_profiles" "p" ON "p"."id" = "c"."cur"
    WHERE "p"."id" IS NULL OR "p"."blocked_at" IS NOT NULL OR "c"."depth" >= 64
  ),
  "usable" AS (
    SELECT "p".* FROM "installation_profiles" "p"
    WHERE "p"."blocked_at" IS NULL
      AND "p"."id" NOT IN (SELECT "id" FROM "broken")
      AND ("p"."retired_at" IS NULL OR "p"."id" IN (SELECT "id" FROM "in_use"))
      AND jsonb_typeof("p"."definition"->'provider') = 'object'
  ),
  "matched" AS (
    SELECT DISTINCT ON ("u"."id") "u"."id" AS "profile_id", "c"."id" AS "connection_id"
    FROM "usable" "u"
    JOIN "provider_connections" "c" ON "c"."disabled_at" IS NULL AND (
      "c"."definition" = "u"."definition"->'provider'
      OR (
        "c"."replaces_auth" IS NOT NULL
        AND "c"."definition" || jsonb_build_object('auth', "c"."replaces_auth") = "u"."definition"->'provider'
        AND NOT EXISTS (
          SELECT 1 FROM "provider_connections" "o"
          WHERE "o"."disabled_at" IS NULL AND "o"."definition" = "u"."definition"->'provider'
        )
      )
    )
    ORDER BY "u"."id", ("c"."definition" = "u"."definition"->'provider') DESC, "c"."id"
  ),
  "offered" ("connection_id", "src", "created_at", "profile_id", "pos", "model") AS (
    SELECT "m"."connection_id", 0, "u"."created_at", "u"."id", 0::bigint, "u"."definition"->>'model'
    FROM "matched" "m" JOIN "usable" "u" ON "u"."id" = "m"."profile_id"
    WHERE jsonb_typeof("u"."definition"->'model') = 'string'
    UNION ALL
    SELECT "m"."connection_id", 0, "u"."created_at", "u"."id", "e"."ord", "e"."value" #>> '{}'
    FROM "matched" "m" JOIN "usable" "u" ON "u"."id" = "m"."profile_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof("u"."definition"->'models') = 'array' THEN "u"."definition"->'models' ELSE '[]'::jsonb END
    ) WITH ORDINALITY "e" ("value", "ord")
    WHERE jsonb_typeof("e"."value") = 'string'
    UNION ALL
    SELECT "m"."connection_id", 1, "w"."created_at", "w"."id", 0::bigint, "w"."model"
    FROM "workspace_profiles" "w" JOIN "matched" "m" ON "m"."profile_id" = "w"."base_profile_id"
    WHERE "w"."retired_at" IS NULL OR "w"."id" IN (SELECT "id" FROM "in_use")
    UNION ALL
    SELECT "m"."connection_id", 1, "w"."created_at", "w"."id", "e"."ord", "e"."value" #>> '{}'
    FROM "workspace_profiles" "w" JOIN "matched" "m" ON "m"."profile_id" = "w"."base_profile_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof("w"."models") = 'array' THEN "w"."models" ELSE '[]'::jsonb END
    ) WITH ORDINALITY "e" ("value", "ord")
    WHERE ("w"."retired_at" IS NULL OR "w"."id" IN (SELECT "id" FROM "in_use"))
      AND jsonb_typeof("e"."value") = 'string'
  ),
  "firsts" AS (
    SELECT DISTINCT ON ("connection_id", "model") *
    FROM "offered" WHERE "model" <> ''
    ORDER BY "connection_id", "model", "src", "created_at", "profile_id", "pos"
  ),
  "lists" AS (
    SELECT "connection_id", jsonb_agg("model" ORDER BY "src", "created_at", "profile_id", "pos") AS "models"
    FROM "firsts" GROUP BY "connection_id"
  ),
  "families" AS (
    SELECT "m"."connection_id", (array_agg(DISTINCT "u"."definition"->'model_families'))[1] AS "families"
    FROM "matched" "m" JOIN "usable" "u" ON "u"."id" = "m"."profile_id"
    WHERE jsonb_typeof("u"."definition"->'model_families') = 'object'
    GROUP BY "m"."connection_id"
    HAVING count(DISTINCT "u"."definition"->'model_families') = 1
  )
UPDATE "provider_connections" "c"
SET "models" = "l"."models", "model_families" = COALESCE("c"."model_families", "f"."families")
FROM "lists" "l" LEFT JOIN "families" "f" ON "f"."connection_id" = "l"."connection_id"
WHERE "c"."id" = "l"."connection_id" AND "c"."models" = '[]'::jsonb;--> statement-breakpoint

-- Slack outbox rows that name no session (welcome and other notices) are not
-- session data: they are set aside here and put back after the truncate.
CREATE TEMP TABLE "slack_outbox_kept" AS SELECT * FROM "slack_outbox" WHERE "session_id" IS NULL;--> statement-breakpoint
-- Session data, all of it hangs off sessions. The CASCADE empties these 45
-- tables (the 6 named and the 39 that reference them): achievement_judgment_usage,
-- achievement_judgments, approval_checkpoint_voids, approval_checkpoints,
-- attempts, checkpoint_outputs, checkpoint_restore_check, checkpoints,
-- control_intents, events, executions, github_workflow_dispatches,
-- pending_requests, permission_grants, provider_usage, pull_requests,
-- push_continuations, push_follow_ups, push_intents, push_requests,
-- queue_messages, session_achievements, session_commit_attributions,
-- session_event_archives, session_outcomes, session_repository_attachments,
-- session_share_targets, session_shares, session_title_requests,
-- slack_outbox, slack_thread_status, turn_continuations, turns,
-- unassigned_sessions, worker_credentials, worker_launches, plus the six
-- named below and, in the second TRUNCATE, agent_activation_events,
-- session_links and agent_releases. agents, agent_usage and
-- tool_call_audits are not in the closure and keep their rows.
TRUNCATE "sessions", "session_model_usage", "session_pre_metering_cost", "tool_calls", "tool_descriptions", "checkpoint_output_objects" CASCADE;--> statement-breakpoint
-- No agent keeps an active release or a pending draft.
ALTER TABLE "agents" DROP CONSTRAINT "agents_active_release_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_draft_check";--> statement-breakpoint
UPDATE "agents" SET "active_release_id" = NULL, "activation_revision" = -1, "draft_version_id" = NULL, "draft_profile_id" = NULL, "draft_model_source" = NULL, "draft_failure" = NULL;--> statement-breakpoint
TRUNCATE "agent_activation_events", "session_links", "agent_releases" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_active_release_fk" FOREIGN KEY ("id","active_release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

INSERT INTO "slack_outbox" SELECT * FROM "slack_outbox_kept";--> statement-breakpoint
DROP TABLE "slack_outbox_kept";--> statement-breakpoint

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
