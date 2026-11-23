-- migrate:no-transaction
-- A channel's archive, rename and delete reach the agent: conversations keep
-- the channel's state and name, a deleted channel's binding becomes `gone`,
-- and an event of it is dropped as `channel_gone`. conversations and
-- slack_inbound_events only grow, so their CHECKs are added NOT VALID and
-- validated in a statement of their own; surface_bindings is small. Every
-- statement may run again.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "channel_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "channel_state_us" bigint;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "channel_name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "channel_name_us" bigint;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_channel_state_check", ADD CONSTRAINT "conversations_channel_state_check" CHECK ("conversations"."channel_state" IN ('active','archived','deleted') AND ("conversations"."kind" = 'channel' OR ("conversations"."channel_state" = 'active' AND "conversations"."channel_state_us" IS NULL AND "conversations"."channel_name" IS NULL AND "conversations"."channel_name_us" IS NULL))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_channel_state_check";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_channel_name_check", ADD CONSTRAINT "conversations_channel_name_check" CHECK ("conversations"."channel_name" IS NULL OR char_length("conversations"."channel_name") BETWEEN 1 AND 80) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_channel_name_check";--> statement-breakpoint
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_drop_reason_check", ADD CONSTRAINT "slack_inbound_events_drop_reason_check" CHECK ("slack_inbound_events"."drop_reason" IS NULL OR "slack_inbound_events"."drop_reason" IN ('not_installed','installation_unverified','installation_revoked','unidentified','identity_revoked','bot_mismatch','agent_mismatch','agent_archived','app_mismatch','bot_message','bot_allowlist_empty','bot_not_allowed','own_bot_user','werft_agent_bot','slackbot','message_subtype','unsupported_event','user_tokens_only','channel_pending_approval','channel_left','channel_gone')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" VALIDATE CONSTRAINT "slack_inbound_events_drop_reason_check";--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_status_check", ADD CONSTRAINT "surface_bindings_status_check" CHECK ("surface_bindings"."status" IN ('ready','pending_approval','left','gone','partial','failed','revoked'));--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_gone_check", ADD CONSTRAINT "surface_bindings_gone_check" CHECK ("surface_bindings"."status" <> 'gone' OR ("surface_bindings"."surface" = 'slack' AND "surface_bindings"."installation_id" IS NOT NULL AND "surface_bindings"."external_surface_id" IS NOT NULL AND COALESCE("surface_bindings"."surface_kind" IN ('public_channel', 'private_channel'), false) AND NOT "surface_bindings"."home" AND "surface_bindings"."approved_at" IS NULL AND "surface_bindings"."approved_lifecycle_us" IS NULL));
