-- migrate:no-transaction
-- No outbox row names a Slack user (U…, W… on Enterprise Grid) as its channel
-- but a model notice's direct message: posting to one would open a DM the
-- person never started. No release wrote such a row, so the count is for the
-- log; a row it finds fails VALIDATE, and the constraint, added NOT VALID,
-- still refuses new ones. Counts only: what the rows held stays out of the
-- log. Every statement may run again: a failure part way leaves the ones
-- before it committed, and the next run starts from the top.
DO $$
DECLARE
  found integer;
BEGIN
  SELECT count(*) INTO found FROM "slack_outbox"
  WHERE "channel_id" ~ '^[UW]' AND "kind" <> 'model_notice';
  IF found > 0 THEN
    RAISE NOTICE '0306: % slack_outbox rows name a Slack user as their channel', found;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_channel_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_channel_check" CHECK ("slack_outbox"."channel_id" !~ '^[UW]' OR "slack_outbox"."kind" = 'model_notice') NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_channel_check";
