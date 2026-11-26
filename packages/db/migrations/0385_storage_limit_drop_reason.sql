-- migrate:no-transaction
-- Adds the `storage_limit_exceeded` drop reason (the storage limit refused a
-- Slack input). slack_inbound_events only grows, so its drop-reason CHECK is
-- added NOT VALID and validated in its own statement: the scan then holds no
-- write lock. Every statement may run again.
ALTER TABLE "slack_inbound_events" DROP CONSTRAINT IF EXISTS "slack_inbound_events_drop_reason_check", ADD CONSTRAINT "slack_inbound_events_drop_reason_check" CHECK ("slack_inbound_events"."drop_reason" IS NULL OR "slack_inbound_events"."drop_reason" IN ('not_installed','installation_unverified','installation_revoked','unidentified','identity_revoked','bot_mismatch','agent_mismatch','agent_archived','app_mismatch','bot_message','bot_allowlist_empty','bot_not_allowed','own_bot_user','werft_agent_bot','slackbot','message_subtype','unsupported_event','user_tokens_only','channel_pending_approval','channel_left','channel_gone','storage_limit_exceeded')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_inbound_events" VALIDATE CONSTRAINT "slack_inbound_events_drop_reason_check";
