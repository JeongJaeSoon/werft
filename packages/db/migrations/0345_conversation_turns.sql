-- migrate:no-transaction
-- The conversation turn table: one row per turn, its calls and engagements
-- pointing at it, and a web input's row holding the input's text. The new
-- columns of the three existing tables are nullable with no default, so no
-- row is rewritten and an older image goes on writing rows without them.
-- Their constraints are added NOT VALID and validated in statements of their
-- own, whose scans hold no write lock. A web input's text goes to its turn
-- row; the input row keeps a copy while an older image in the support window
-- still reads it there, and the origin check allows it without one for the
-- release that stops writing it. The API's start pass gives the web inputs
-- taken before this their turn rows, in batches outside any migration. Every
-- statement may run again.
CREATE TABLE IF NOT EXISTS "conversation_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"topic_id" uuid,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"requester_kind" text NOT NULL,
	"requester_id" text NOT NULL,
	"input_text" text,
	"decision" text,
	"decision_reason" text,
	"answer_text" text,
	"sources" jsonb,
	"release_id" text,
	"slack_installation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "conversation_turns_origin_check" CHECK ("conversation_turns"."origin" IN ('web_input','m2')),
	CONSTRAINT "conversation_turns_state_check" CHECK ("conversation_turns"."state" IN ('received','running','decided','no_decision','voided_by_delete')),
	CONSTRAINT "conversation_turns_decision_check" CHECK ("conversation_turns"."decision" IN ('reply','route_to_task','spawn_task','no_reply')),
	CONSTRAINT "conversation_turns_shape_check" CHECK (CASE "conversation_turns"."origin"
        WHEN 'web_input' THEN "conversation_turns"."state" = 'received' AND "conversation_turns"."input_text" IS NOT NULL AND "conversation_turns"."requester_kind" = 'user' AND "conversation_turns"."decision" IS NULL AND "conversation_turns"."decision_reason" IS NULL AND "conversation_turns"."answer_text" IS NULL AND "conversation_turns"."ended_at" IS NULL
        ELSE "conversation_turns"."state" <> 'received' AND "conversation_turns"."input_text" IS NULL
          AND ("conversation_turns"."decision" IS NOT NULL) = ("conversation_turns"."state" = 'decided')
          AND ("conversation_turns"."decision_reason" IS NULL OR "conversation_turns"."decision" IS NOT NULL)
          AND ("conversation_turns"."answer_text" IS NULL OR "conversation_turns"."decision" IS NOT NULL)
          AND ("conversation_turns"."ended_at" IS NULL) = ("conversation_turns"."state" = 'running')
      END),
	CONSTRAINT "conversation_turns_text_check" CHECK (("conversation_turns"."decision_reason" IS NULL OR char_length("conversation_turns"."decision_reason") BETWEEN 1 AND 1000) AND ("conversation_turns"."answer_text" IS NULL OR char_length("conversation_turns"."answer_text") <= 16000))
);--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_agent_fk", ADD CONSTRAINT "conversation_turns_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_conversation_fk", ADD CONSTRAINT "conversation_turns_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_topic_fk", ADD CONSTRAINT "conversation_turns_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."conversation_topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_release_fk", ADD CONSTRAINT "conversation_turns_release_fk" FOREIGN KEY ("agent_id","release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_slack_installation_fk", ADD CONSTRAINT "conversation_turns_slack_installation_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turns_conversation_idx" ON "conversation_turns" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turns_topic_idx" ON "conversation_turns" USING btree ("topic_id") WHERE "conversation_turns"."topic_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turns_sources_idx" ON "conversation_turns" USING gin ("sources" jsonb_path_ops) WHERE "conversation_turns"."sources" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "conversation_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "conversation_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "body_sha256" bytea;--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_conversation_turn_fk", ADD CONSTRAINT "conversation_calls_conversation_turn_fk" FOREIGN KEY ("conversation_turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_conversation_turn_fk";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_conversation_turn_check", ADD CONSTRAINT "conversation_calls_conversation_turn_check" CHECK ("conversation_calls"."conversation_turn_id" IS NULL OR COALESCE("conversation_calls"."call_class" = 'm2', false)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_conversation_turn_check";--> statement-breakpoint
ALTER TABLE "conversation_engagements" DROP CONSTRAINT IF EXISTS "conversation_engagements_conversation_turn_fk", ADD CONSTRAINT "conversation_engagements_conversation_turn_fk" FOREIGN KEY ("conversation_turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_engagements" VALIDATE CONSTRAINT "conversation_engagements_conversation_turn_fk";--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_conversation_turn_fk", ADD CONSTRAINT "conversation_inputs_conversation_turn_fk" FOREIGN KEY ("conversation_turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_conversation_turn_fk";--> statement-breakpoint
ALTER TABLE "conversation_inputs" DROP CONSTRAINT IF EXISTS "conversation_inputs_origin_check", ADD CONSTRAINT "conversation_inputs_origin_check" CHECK (("conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."body" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NOT NULL AND "conversation_inputs"."buffer_expires_at" IS NULL AND "conversation_inputs"."conversation_turn_id" IS NULL AND "conversation_inputs"."body_sha256" IS NULL) OR ("conversation_inputs"."client_message_id" IS NOT NULL AND "conversation_inputs"."client_message_id" ~ '^[A-Za-z0-9_-]{1,128}$' AND "conversation_inputs"."requester_kind" = 'user' AND "conversation_inputs"."slack_mirror" IS NOT NULL AND "conversation_inputs"."slack_mirror" IN ('not_target','pending','unconfirmed') AND "conversation_inputs"."buffer_expires_at" IS NULL AND (("conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."conversation_turn_id" IS NULL AND "conversation_inputs"."body_sha256" IS NULL) OR ("conversation_inputs"."conversation_turn_id" IS NOT NULL AND "conversation_inputs"."body_sha256" IS NOT NULL AND octet_length("conversation_inputs"."body_sha256") = 32))) OR ("conversation_inputs"."buffer_expires_at" IS NOT NULL AND "conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NULL AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."slack_ts" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'slack_user' AND "conversation_inputs"."conversation_turn_id" IS NULL AND "conversation_inputs"."body_sha256" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_origin_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_conversation_turn_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_conversation_turn_idx" ON "conversation_calls" USING btree ("conversation_turn_id") WHERE "conversation_calls"."conversation_turn_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_engagements_conversation_turn_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_engagements_conversation_turn_idx" ON "conversation_engagements" USING btree ("conversation_turn_id") WHERE "conversation_engagements"."conversation_turn_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_inputs_conversation_turn_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_inputs_conversation_turn_idx" ON "conversation_inputs" USING btree ("conversation_turn_id") WHERE "conversation_inputs"."conversation_turn_id" IS NOT NULL;
