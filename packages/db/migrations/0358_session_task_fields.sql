-- migrate:no-transaction
-- A task session's fields, all null on every session there is now. Every
-- statement may run again: a failure part way leaves the ones before it
-- committed, and the next run starts from the top. The CHECK goes on NOT
-- VALID so adding it takes no scan under a write lock; VALIDATE then scans
-- without blocking writes.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "task_request" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "task_interpretation" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "task_closing" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "task_closed_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_task_closed_reason_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_closed_reason_check" CHECK ("sessions"."task_closed_reason" IS NULL OR ("sessions"."task_closed_reason" IN ('completed', 'cancelled', 'failed', 'abandoned') AND "sessions"."admission_state" IN ('closing', 'closed'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_task_closed_reason_check";
