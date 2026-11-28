-- migrate:no-transaction
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "reserve_priced_by" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "priced_by" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_priced_by_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD CONSTRAINT "conversation_calls_priced_by_check" CHECK ("conversation_calls"."reserve_priced_by" IN ('table', 'litellm', 'unknown', 'unmetered') AND "conversation_calls"."priced_by" IN ('table', 'litellm', 'unknown', 'unmetered')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_priced_by_check";
