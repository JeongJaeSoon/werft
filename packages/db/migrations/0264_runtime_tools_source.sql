-- migrate:no-transaction
-- Where a session's claim takes its built-in tools from. sessions only grows,
-- so the column commits on its own (existing rows read the `profile` default,
-- which keeps their claims and checkpoint digests), and the CHECK is added
-- NOT VALID, then validated in its own statement: that scan takes no
-- write-blocking lock. Every statement may run again, so a failure part way
-- leaves the ones before it committed and the next run starts from the top.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_tools_source" text DEFAULT 'profile' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_runtime_tools_source_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_runtime_tools_source_check" CHECK ("sessions"."runtime_tools_source" IN ('profile','release')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_runtime_tools_source_check";
