-- migrate:no-transaction
-- The limit that ended a conversation turn without a decision, and who held
-- the turn there: the runtime's own count or the server's behind it.
-- conversation_turns gains two nullable columns with no default, so no row is
-- rewritten; their constraint is added NOT VALID and validated in its own
-- statement. Every statement may run again.
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "limit_reached" text;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "limit_reached_by" text;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_limit_check", ADD CONSTRAINT "conversation_turns_limit_check" CHECK (("conversation_turns"."limit_reached" IS NULL) = ("conversation_turns"."limit_reached_by" IS NULL) AND ("conversation_turns"."limit_reached" IS NULL OR ("conversation_turns"."state" = 'no_decision' AND "conversation_turns"."limit_reached" IN ('model_call_limit','tool_call_limit','time_limit') AND "conversation_turns"."limit_reached_by" IN ('runner','server')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_turns" VALIDATE CONSTRAINT "conversation_turns_limit_check";
