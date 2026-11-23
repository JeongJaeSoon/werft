-- migrate:no-transaction
-- A session from a private Slack channel is seen by the channel's current
-- members alone: session_shares takes the scope private_channel. The table
-- grows with sessions, so the widened CHECK is added NOT VALID and validated
-- in a statement of its own. Every statement may run again.
ALTER TABLE "session_shares" DROP CONSTRAINT IF EXISTS "session_shares_scope_check", ADD CONSTRAINT "session_shares_scope_check" CHECK ("session_shares"."scope" IN ('private', 'people', 'team', 'workspace', 'private_channel')) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_shares" VALIDATE CONSTRAINT "session_shares_scope_check";
