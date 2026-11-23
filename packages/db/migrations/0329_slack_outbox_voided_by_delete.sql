-- migrate:no-transaction
-- Adds the `voided_by_delete` outbox status: a row one of whose sources was
-- deleted in Slack before its send began, never sent. slack_outbox only
-- grows, so its status CHECK is added NOT VALID and validated in its own
-- statement: the scan then holds no write lock. `sources_turn` names the
-- turn whose sources a row carries, so an overflowed set is judged by that
-- turn and the ones before it; nullable, rows written before it are judged
-- by every turn. Every statement may run again.
ALTER TABLE "slack_outbox" ADD COLUMN IF NOT EXISTS "sources_turn" integer;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_status_check", ADD CONSTRAINT "slack_outbox_status_check" CHECK ("slack_outbox"."status" IN ('pending', 'sending', 'sent', 'failed', 'uncertain', 'voided_by_delete')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_status_check";
