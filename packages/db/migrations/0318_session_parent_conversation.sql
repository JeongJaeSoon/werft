-- migrate:no-transaction
-- A session's main conversation. The column starts empty: fillSessionParents
-- fills the linked sessions at host start, since an UPDATE of sessions here
-- would hold its rows for the whole table. The key is added NOT VALID and
-- validated after; every row is null, so VALIDATE finds nothing to check.
-- Every statement may run again: a failure part way leaves the ones before
-- it committed, and the next run starts from the top.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "parent_conversation_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_parent_conversation_id_conversations_id_fk'
      AND conrelid = '"sessions"'::regclass
  ) THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_conversation_id_conversations_id_fk" FOREIGN KEY ("parent_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_parent_conversation_id_conversations_id_fk";
