-- migrate:no-transaction
-- Judgment batches: an agent's buffered messages of one Slack channel closed
-- together for M1's judgment, and per channel counts of batches past M1's
-- cap and of messages that expired unjudged. Both tables are new and empty.
-- conversation_inputs gains a nullable column with no default, so no row is
-- rewritten; its constraints are added NOT VALID and validated in their own
-- statements, and its index is built concurrently. Every statement may run
-- again.
CREATE TABLE IF NOT EXISTS "judgment_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"release_id" text NOT NULL,
	"state" text NOT NULL,
	"model_called" boolean,
	"closed_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "judgment_batches_state_check" CHECK ("judgment_batches"."state" IN ('judging', 'judged', 'failed', 'rate_limited') AND ("judgment_batches"."state" = 'judging') = ("judgment_batches"."ended_at" IS NULL) AND ("judgment_batches"."state" = 'judged') = ("judgment_batches"."model_called" IS NOT NULL)),
	CONSTRAINT "judgment_batches_slack_check" CHECK ("judgment_batches"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "judgment_batches"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment_channel_tallies" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"rate_limited_count" bigint DEFAULT 0 NOT NULL,
	"unjudged_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "judgment_channel_tallies_pk" PRIMARY KEY("agent_id","slack_team_id","slack_channel_id"),
	CONSTRAINT "judgment_channel_tallies_count_check" CHECK ("judgment_channel_tallies"."rate_limited_count" >= 0 AND "judgment_channel_tallies"."unjudged_count" >= 0),
	CONSTRAINT "judgment_channel_tallies_slack_check" CHECK ("judgment_channel_tallies"."slack_team_id" ~ '^[A-Za-z0-9_-]{1,64}$' AND "judgment_channel_tallies"."slack_channel_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "judgment_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "judgment_batches" DROP CONSTRAINT IF EXISTS "judgment_batches_agent_fk", ADD CONSTRAINT "judgment_batches_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_batches" DROP CONSTRAINT IF EXISTS "judgment_batches_conversation_fk", ADD CONSTRAINT "judgment_batches_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_batches" DROP CONSTRAINT IF EXISTS "judgment_batches_release_fk", ADD CONSTRAINT "judgment_batches_release_fk" FOREIGN KEY ("agent_id","release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_channel_tallies" DROP CONSTRAINT IF EXISTS "judgment_channel_tallies_agent_fk", ADD CONSTRAINT "judgment_channel_tallies_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "judgment_batches_judging_uniq" ON "judgment_batches" USING btree ("agent_id","slack_team_id","slack_channel_id") WHERE "judgment_batches"."state" = 'judging';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_batches_channel_idx" ON "judgment_batches" USING btree ("agent_id","slack_team_id","slack_channel_id","closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judgment_batches_closed_idx" ON "judgment_batches" USING btree ("closed_at");--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_judgment_batch_id_judgment_batches_id_fk", ADD CONSTRAINT "conversation_inputs_judgment_batch_id_judgment_batches_id_fk" FOREIGN KEY ("judgment_batch_id") REFERENCES "public"."judgment_batches"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_judgment_batch_id_judgment_batches_id_fk";--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_judgment_batch_check", ADD CONSTRAINT "conversation_inputs_judgment_batch_check" CHECK ("conversation_inputs"."judgment_batch_id" IS NULL OR "conversation_inputs"."buffer_expires_at" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_judgment_batch_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_inputs_judgment_batch_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_inputs_judgment_batch_idx" ON "conversation_inputs" USING btree ("judgment_batch_id") WHERE "conversation_inputs"."judgment_batch_id" IS NOT NULL;
