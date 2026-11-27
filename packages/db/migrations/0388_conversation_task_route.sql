-- migrate:no-transaction
-- A mention turn's route_to_task (v1-b/E4): the open task the decision
-- named, kept on the turn so its effect checks it again and the turn list
-- shows where it went, and the threads a turn handed a message from to a
-- task in another thread. The new column is nullable, no row rewritten; an
-- older image neither reads nor writes it. The CHECK is added NOT VALID and
-- validated in a statement of its own, so no scan holds a write lock. The
-- new table is empty, so its indexes are built plainly. Every statement may
-- run again.
CREATE TABLE IF NOT EXISTS "task_thread_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"session_id" uuid NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_thread_mirrors_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "task_thread_mirrors_rev_check" CHECK ("task_thread_mirrors"."rev" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_thread_mirrors_thread_idx" ON "task_thread_mirrors" USING btree ("installation_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_thread_mirrors_session_idx" ON "task_thread_mirrors" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD COLUMN IF NOT EXISTS "routed_session_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_turns" DROP CONSTRAINT IF EXISTS "conversation_turns_task_check";--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_task_check" CHECK (("conversation_turns"."task_draft" IS NULL OR "conversation_turns"."decision" = 'spawn_task') AND ("conversation_turns"."routed_session_id" IS NULL OR "conversation_turns"."decision" = 'route_to_task') AND ("conversation_turns"."task_effect" IS NULL OR ("conversation_turns"."decision" = 'spawn_task' AND "conversation_turns"."task_effect" IN ('opened','refused','failed','voided')) OR ("conversation_turns"."decision" = 'route_to_task' AND "conversation_turns"."task_effect" IN ('routed','refused','failed','voided')))) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_turns" VALIDATE CONSTRAINT "conversation_turns_task_check";
