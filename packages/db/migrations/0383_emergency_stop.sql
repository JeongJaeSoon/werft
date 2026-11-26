-- migrate:no-transaction
-- An emergency stop of an agent in one Slack channel (94S-2205): the
-- binding keeps when, by whom and why it was stopped until the channel is
-- turned on again; a session it stopped is paused for that reason; a turn it
-- cut off is never put in front of the next turn; the channel's one line is
-- an outbox kind of its own. Three nullable columns, no row rewritten; an
-- older image neither reads nor writes them. Each constraint is dropped and
-- added again NOT VALID, then validated in a statement of its own, so no scan
-- holds a write lock. Every statement may run again.
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "emergency_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "emergency_stopped_by" uuid;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "emergency_stop_reason" text;--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_emergency_stopped_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_emergency_stopped_by_users_id_fk" FOREIGN KEY ("emergency_stopped_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "surface_bindings" VALIDATE CONSTRAINT "surface_bindings_emergency_stopped_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_emergency_stop_check";--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_emergency_stop_check" CHECK (("surface_bindings"."emergency_stopped_at" IS NULL) = ("surface_bindings"."emergency_stop_reason" IS NULL) AND ("surface_bindings"."emergency_stopped_at" IS NULL OR "surface_bindings"."mode" = 'off')) NOT VALID;--> statement-breakpoint
ALTER TABLE "surface_bindings" VALIDATE CONSTRAINT "surface_bindings_emergency_stop_check";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_pause_reason_check";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_pause_reason_check" CHECK ("sessions"."pause_reason" IS NULL OR ("sessions"."pause_reason" IN ('awaiting_input', 'emergency_stopped') AND "sessions"."admission_state" IN ('pausing', 'paused'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_pause_reason_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" DROP CONSTRAINT IF EXISTS "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "slack_outbox" ADD CONSTRAINT "slack_outbox_kind_check" CHECK ("slack_outbox"."kind" IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice', 'input_mirror', 'channel_notice', 'progress', 'reaction', 'conversation_reply', 'emergency_stop_notice')) NOT VALID;--> statement-breakpoint
ALTER TABLE "slack_outbox" VALIDATE CONSTRAINT "slack_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT IF EXISTS "turns_prepend_skip_reason_check";--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_prepend_skip_reason_check" CHECK ("turns"."prepend_skip_reason" IS NULL OR ("turns"."prepended_turn" IS NOT NULL AND "turns"."prepend_skip_reason" IN ('continuation','deleted_source','unreadable_web_input','emergency_stopped'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "turns" VALIDATE CONSTRAINT "turns_prepend_skip_reason_check";
