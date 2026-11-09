-- migrate:no-transaction
-- Adds channel_pending_approval to the drop reasons. slack_inbound_events only
-- grows, so the CHECK is added NOT VALID and validated in its own statement:
-- the scan then holds no write lock. Every statement may run again, so a
-- failure part way leaves the ones before it committed and the next run starts
-- from the top.
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_drop_reason_check";--> statement-breakpoint
ALTER TABLE "slack_inbound_events" ADD CONSTRAINT "slack_inbound_events_drop_reason_check" CHECK ("slack_inbound_events"."drop_reason" IS NULL OR "slack_inbound_events"."drop_reason" IN ('not_installed','installation_unverified','installation_revoked','unidentified','identity_revoked','bot_mismatch','agent_mismatch','agent_archived','app_mismatch','bot_message','own_bot_user','message_subtype','unsupported_event','user_tokens_only','channel_pending_approval')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" VALIDATE CONSTRAINT "slack_inbound_events_drop_reason_check";
