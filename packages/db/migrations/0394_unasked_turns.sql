-- migrate:no-transaction
-- An unasked turn (v1-b/U1): a judgment that spoke names the one message it
-- answers (target_ts, of its refs), the agent's turn made of it once the
-- rollout is on (turn_id, at most one per turn), and what became of it
-- (answer). A quiet judgment may give invalid_target when it named no
-- message it read. Nullable columns, no row rewritten; an older image neither
-- reads nor writes them, and every row before has all three null, which the
-- CHECKs allow. The CHECKs and the foreign key are added NOT VALID and
-- validated in statements of their own, so no scan holds a write lock. A
-- turn's row going empties turn_id and keeps the record and its answer. The
-- unique index skips null turn_id, built CONCURRENTLY: judgments are written
-- on every batch. Every statement may run again.
ALTER TABLE "conversation_judgments" ADD COLUMN IF NOT EXISTS "target_ts" text;--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD COLUMN IF NOT EXISTS "turn_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD COLUMN IF NOT EXISTS "answer" text;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_verdict_check";--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD CONSTRAINT "conversation_judgments_verdict_check" CHECK (CASE "conversation_judgments"."outcome"
        WHEN 'judged' THEN "conversation_judgments"."decision" IN ('speak','quiet') AND ("conversation_judgments"."reason" IN ('not_for_agent','human_conversation','already_handled','out_of_scope','needs_agent','unclear') OR ("conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('invalid_target')))
        WHEN 'not_called' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('budget_refused','concurrency_limited','rate_limited','input_too_large','no_active_release','model_unavailable')
        WHEN 'failed' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('timed_out','unreachable','provider_error','malformed')
        WHEN 'voided' THEN "conversation_judgments"."decision" IS NULL AND "conversation_judgments"."reason" IN ('voided_by_delete','voided_by_edit')
        ELSE "conversation_judgments"."outcome" IS NULL AND "conversation_judgments"."decision" IS NULL AND "conversation_judgments"."reason" IS NULL
      END AND ("conversation_judgments"."outcome" IS NULL) = ("conversation_judgments"."judged_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_judgments" VALIDATE CONSTRAINT "conversation_judgments_verdict_check";--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_answer_check";--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD CONSTRAINT "conversation_judgments_answer_check" CHECK (("conversation_judgments"."target_ts" IS NULL OR ("conversation_judgments"."outcome" = 'judged' AND "conversation_judgments"."decision" = 'speak' AND "conversation_judgments"."target_ts" = ANY("conversation_judgments"."refs"))) AND ("conversation_judgments"."turn_id" IS NULL OR "conversation_judgments"."target_ts" IS NOT NULL) AND ("conversation_judgments"."answer" IS NULL OR ("conversation_judgments"."target_ts" IS NOT NULL AND "conversation_judgments"."answer" IN ('replied','no_reply','no_decision','budget_refused','source_deleted','channel_stopped','not_started')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_judgments" VALIDATE CONSTRAINT "conversation_judgments_answer_check";--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_turn_fk";--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD CONSTRAINT "conversation_judgments_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_judgments" VALIDATE CONSTRAINT "conversation_judgments_turn_fk";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_judgments_turn_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "conversation_judgments_turn_uniq" ON "conversation_judgments" USING btree ("turn_id") WHERE "conversation_judgments"."turn_id" IS NOT NULL;
