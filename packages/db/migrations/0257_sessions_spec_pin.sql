-- migrate:no-transaction
-- The spec a session runs. sessions only grows, so each ADD COLUMN commits on
-- its own (its ACCESS EXCLUSIVE lock is gone before the next statement) and
-- the CHECK is added NOT VALID, then validated in its own statement: that scan
-- takes no write-blocking lock. Every statement may run again, so a failure
-- part way leaves the ones before it committed and the next run starts from
-- the top.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_spec" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "spec_source" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "spec_source_digest" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "spec_digest" text;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_spec_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_spec_check" CHECK (("sessions"."runtime_spec" IS NULL) = ("sessions"."spec_source" IS NULL) AND ("sessions"."runtime_spec" IS NULL) = ("sessions"."spec_source_digest" IS NULL) AND ("sessions"."runtime_spec" IS NULL) = ("sessions"."spec_digest" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_spec_check";
