-- migrate:no-transaction
-- Web inputs in conversation_inputs: a web input is taken before it becomes
-- a turn, so turn_id may be null, and it carries the client's retry key, its
-- text and whether Slack is to mirror it. Every row before this migration is
-- a Slack input, which the check holds to having a turn, so an image from
-- before it runs on it unchanged.
--
-- The table only grows: the check is added NOT VALID and validated in a
-- statement of its own, the index is built CONCURRENTLY. Every statement may
-- run again: a failure part way leaves the ones before it committed, and the
-- next run starts from the top.
ALTER TABLE "conversation_inputs" ALTER COLUMN "turn_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "client_message_id" text;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "body" text;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "slack_mirror" text;--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_inputs_client_message_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "conversation_inputs_client_message_uniq" ON "conversation_inputs" USING btree ("agent_id","requester_kind","requester_id","client_message_id") WHERE "conversation_inputs"."client_message_id" IS NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_inputs_origin_check'
      AND conrelid = '"conversation_inputs"'::regclass
  ) THEN
    ALTER TABLE "conversation_inputs" ADD CONSTRAINT "conversation_inputs_origin_check" CHECK (("conversation_inputs"."client_message_id" IS NULL AND "conversation_inputs"."body" IS NULL AND "conversation_inputs"."slack_mirror" IS NULL AND "conversation_inputs"."turn_id" IS NOT NULL) OR ("conversation_inputs"."client_message_id" IS NOT NULL AND "conversation_inputs"."client_message_id" ~ '^[A-Za-z0-9_-]{1,128}$' AND "conversation_inputs"."body" IS NOT NULL AND "conversation_inputs"."requester_kind" = 'user' AND "conversation_inputs"."slack_mirror" IS NOT NULL AND "conversation_inputs"."slack_mirror" IN ('not_target','pending'))) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "conversation_inputs" VALIDATE CONSTRAINT "conversation_inputs_origin_check";
