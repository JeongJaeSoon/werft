-- migrate:no-transaction
-- What the first delivery of a turn decided about the cut-off turn right
-- before it (worker_ownership_lost): the input it put in front, or the one it
-- left out and why (a continuation's is written with it), so a redelivery
-- decides the same. Two nullable columns, no row rewritten; an older image
-- neither reads nor writes them. The CHECK is added NOT VALID and validated
-- in a statement of its own, so no scan holds a write lock. Every statement
-- may run again.
ALTER TABLE "turns" ADD COLUMN IF NOT EXISTS "prepended_turn" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN IF NOT EXISTS "prepend_skip_reason" text;--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT IF EXISTS "turns_prepend_skip_reason_check";--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_prepend_skip_reason_check" CHECK ("turns"."prepend_skip_reason" IS NULL OR ("turns"."prepended_turn" IS NOT NULL AND "turns"."prepend_skip_reason" IN ('continuation','deleted_source','unreadable_web_input'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "turns" VALIDATE CONSTRAINT "turns_prepend_skip_reason_check";
