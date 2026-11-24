-- M1's judgment records: one row per judgment of a batch or of one
-- unmentioned reply, with codes, Slack ts and ids only. The table is new and
-- empty, so its constraints and indexes are made with it. Every statement may
-- run again.
CREATE TABLE IF NOT EXISTS "conversation_judgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"grade" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"refs" text[] NOT NULL,
	"sources" jsonb,
	"judgment_batch_id" uuid,
	"input_id" uuid,
	"release_id" text,
	"call_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"prompt_version" integer NOT NULL,
	"outcome" text,
	"decision" text,
	"reason" text,
	"rule_decision" text,
	"rule_reason" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone,
	CONSTRAINT "conversation_judgments_grade_check" CHECK ("conversation_judgments"."grade" IN ('buffer_m1','m1','m1_to_task','m1_engaged')),
	CONSTRAINT "conversation_judgments_slack_check" CHECK ("conversation_judgments"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "conversation_judgments"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND cardinality("conversation_judgments"."refs") >= 1),
	CONSTRAINT "conversation_judgments_verdict_check" CHECK (CASE "conversation_judgments"."outcome"
        WHEN 'judged' THEN "conversation_judgments"."decision" IN ('speak','quiet') AND "conversation_judgments"."reason" IN ('not_for_agent','human_conversation','already_handled','out_of_scope','needs_agent','unclear')
        WHEN 'not_called' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('budget_refused','concurrency_limited','rate_limited','input_too_large','no_active_release','model_unavailable')
        WHEN 'failed' THEN "conversation_judgments"."decision" = 'quiet' AND "conversation_judgments"."reason" IN ('timed_out','unreachable','provider_error','malformed')
        ELSE "conversation_judgments"."outcome" IS NULL AND "conversation_judgments"."decision" IS NULL AND "conversation_judgments"."reason" IS NULL
      END AND ("conversation_judgments"."outcome" IS NULL) = ("conversation_judgments"."judged_at" IS NULL)),
	CONSTRAINT "conversation_judgments_rule_check" CHECK (CASE WHEN "conversation_judgments"."grade" = 'buffer_m1'
        THEN "conversation_judgments"."rule_decision" IS NULL AND "conversation_judgments"."rule_reason" IS NULL AND "conversation_judgments"."outcome" IS NOT NULL
        ELSE "conversation_judgments"."rule_decision" IN ('reply','skip','none') AND "conversation_judgments"."rule_reason" IN ('addressed_to_other_user','default_reply','stray_reply') AND ("conversation_judgments"."rule_decision" = 'none') = ("conversation_judgments"."grade" = 'm1_engaged')
      END),
	CONSTRAINT "conversation_judgments_call_check" CHECK ("conversation_judgments"."attempts" >= 0 AND ("conversation_judgments"."call_key" IS NULL OR "conversation_judgments"."call_key" ~ '^[A-Za-z0-9_-]{1,128}:m1$') AND ("conversation_judgments"."attempts" = 0 OR "conversation_judgments"."call_key" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_agent_fk", ADD CONSTRAINT "conversation_judgments_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_conversation_fk", ADD CONSTRAINT "conversation_judgments_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_release_fk", ADD CONSTRAINT "conversation_judgments_release_fk" FOREIGN KEY ("agent_id","release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_batch_fk", ADD CONSTRAINT "conversation_judgments_batch_fk" FOREIGN KEY ("judgment_batch_id") REFERENCES "public"."judgment_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_input_fk", ADD CONSTRAINT "conversation_judgments_input_fk" FOREIGN KEY ("input_id") REFERENCES "public"."conversation_inputs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_judgments_input_uniq" ON "conversation_judgments" USING btree ("input_id") WHERE "conversation_judgments"."input_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_judgments_waiting_idx" ON "conversation_judgments" USING btree ("created_at") WHERE "conversation_judgments"."outcome" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_judgments_channel_idx" ON "conversation_judgments" USING btree ("agent_id","slack_team_id","slack_channel_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_judgments_batch_idx" ON "conversation_judgments" USING btree ("judgment_batch_id") WHERE "conversation_judgments"."judgment_batch_id" IS NOT NULL;
