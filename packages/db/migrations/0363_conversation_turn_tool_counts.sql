-- migrate:no-transaction
-- What a conversation turn's read tools have used: the tool calls the server
-- let through and the thread reads among them, counted on the turn's permit
-- so every API process holds the turn to the same limits.
-- conversation_turn_permits gains two columns with a constant default, which
-- rewrites no row; their constraint is added NOT VALID and validated in its
-- own statement. Every statement may run again.
ALTER TABLE "conversation_turn_permits" ADD COLUMN IF NOT EXISTS "tool_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_turn_permits" ADD COLUMN IF NOT EXISTS "thread_reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_turn_permits" DROP CONSTRAINT IF EXISTS "conversation_turn_permits_tool_counts_check", ADD CONSTRAINT "conversation_turn_permits_tool_counts_check" CHECK ("conversation_turn_permits"."tool_calls" >= 0 AND "conversation_turn_permits"."thread_reads" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_turn_permits" VALIDATE CONSTRAINT "conversation_turn_permits_tool_counts_check";
