-- migrate:no-transaction
-- A judgment's result thrown away because a message it read was deleted or
-- edited while the model ran (a1/J6): outcome 'voided', a reason of its own,
-- no decision, and no ts or sources, so no deleted message's place is kept.
-- Both constraints are replaced NOT VALID and validated in their own
-- statements, which do not block writes. Every statement may run again.
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_slack_check", ADD CONSTRAINT "conversation_judgments_slack_check" CHECK ("conversation_judgments"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_judgments"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND CASE WHEN "conversation_judgments"."outcome" = 'voided' THEN cardinality("conversation_judgments"."refs") = 0 AND "conversation_judgments"."sources" IS NULL AND "conversation_judgments"."input_id" IS NULL ELSE cardinality("conversation_judgments"."refs") >= 1 END) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_judgments" VALIDATE CONSTRAINT "conversation_judgments_slack_check";--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_verdict_check", ADD CONSTRAINT "conversation_judgments_verdict_check" CHECK (CASE "conversation_judgments"."outcome"
        WHEN 'judged' THEN "conversation_judgments"."decision" IN ('speak','quiet') AND "conversation_judgments"."reason" IN ('not_for_agent','human_conversation','already_handled','out_of_scope','needs_agent','unclear')
        WHEN 'not_called' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('budget_refused','concurrency_limited','rate_limited','input_too_large','no_active_release','model_unavailable')
        WHEN 'failed' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('timed_out','unreachable','provider_error','malformed')
        WHEN 'voided' THEN "conversation_judgments"."decision" IS NULL AND "conversation_judgments"."reason" IN ('voided_by_delete','voided_by_edit')
        ELSE "conversation_judgments"."outcome" IS NULL AND "conversation_judgments"."decision" IS NULL AND "conversation_judgments"."reason" IS NULL
      END AND ("conversation_judgments"."outcome" IS NULL) = ("conversation_judgments"."judged_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_judgments" VALIDATE CONSTRAINT "conversation_judgments_verdict_check";
