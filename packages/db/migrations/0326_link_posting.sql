-- migrate:no-transaction
-- A link's posting splits into three columns beside `visibility`, which hosts
-- from before them still read: report_mode (null: the binding's), whether web
-- and API inputs show in the thread, and whether cards and questions go
-- there. Their defaults mean what `full` meant, so no row is backfilled here;
-- the API's start pass moves `summary` links. session_links only grows, so its
-- CHECK is added NOT VALID and validated in a statement of its own;
-- surface_bindings is small. Every statement may run again.
ALTER TABLE "session_links" ADD COLUMN IF NOT EXISTS "report_mode" text;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN IF NOT EXISTS "mirror_instructions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "session_links" ADD COLUMN IF NOT EXISTS "post_prompts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "report_mode" text DEFAULT 'per_step' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_links" DROP CONSTRAINT IF EXISTS "session_links_report_mode_check", ADD CONSTRAINT "session_links_report_mode_check" CHECK ("session_links"."report_mode" IS NULL OR "session_links"."report_mode" IN ('notify_only', 'progress', 'per_step', 'none')) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_links" VALIDATE CONSTRAINT "session_links_report_mode_check";--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_report_mode_check", ADD CONSTRAINT "surface_bindings_report_mode_check" CHECK ("surface_bindings"."report_mode" IN ('notify_only','progress','per_step'));
