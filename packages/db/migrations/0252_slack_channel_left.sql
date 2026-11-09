-- migrate:no-transaction
-- Adds the `left` binding status (the bot was removed from a private channel)
-- and the `channel_left` drop reason. surface_bindings holds one row per bound
-- channel, so its two CHECKs are swapped in one statement: there is never a
-- moment without a status check. slack_inbound_events only grows, so its
-- drop-reason CHECK is added NOT VALID and validated in its own statement:
-- the scan then holds no write lock. Every statement may run again, so a
-- failure part way leaves the ones before it committed and the next run starts
-- from the top.
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_status_check", DROP CONSTRAINT IF EXISTS "surface_bindings_left_check", ADD CONSTRAINT "surface_bindings_status_check" CHECK ("surface_bindings"."status" IN ('ready','pending_approval','left','partial','failed','revoked')), ADD CONSTRAINT "surface_bindings_left_check" CHECK ("surface_bindings"."status" <> 'left' OR ("surface_bindings"."surface" = 'slack' AND "surface_bindings"."installation_id" IS NOT NULL AND "surface_bindings"."external_surface_id" IS NOT NULL AND COALESCE("surface_bindings"."surface_kind" = 'private_channel', false) AND NOT "surface_bindings"."home" AND "surface_bindings"."approved_at" IS NULL AND "surface_bindings"."approved_lifecycle_us" IS NULL));--> statement-breakpoint
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_drop_reason_check", ADD CONSTRAINT "slack_inbound_events_drop_reason_check" CHECK ("slack_inbound_events"."drop_reason" IS NULL OR "slack_inbound_events"."drop_reason" IN ('not_installed','installation_unverified','installation_revoked','unidentified','identity_revoked','bot_mismatch','agent_mismatch','agent_archived','app_mismatch','bot_message','own_bot_user','message_subtype','unsupported_event','user_tokens_only','channel_pending_approval','channel_left')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" VALIDATE CONSTRAINT "slack_inbound_events_drop_reason_check";
