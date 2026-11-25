-- Channel summary writes (a1/J8). Each version's time, so the reconciler
-- keeps 7 days of history; the edit time of a text a summary line was made
-- from and of a buffered message's edited body, so an edit removes only the
-- lines made before it; and what became of a batch judgment's summary line.
-- New columns are nullable with no default, so no row is rewritten. The
-- summary check is NOT VALID: every existing row has no summary, and new
-- rows are checked. Every statement may run again.
CREATE TABLE IF NOT EXISTS "channel_summary_versions" (
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"version" bigint NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_summary_versions_workspace_id_team_id_channel_id_version_pk" PRIMARY KEY("workspace_id","team_id","channel_id","version")
);
--> statement-breakpoint
ALTER TABLE "channel_summary_line_sources" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_inputs" ADD COLUMN IF NOT EXISTS "body_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_judgments" ADD COLUMN IF NOT EXISTS "summary" text;--> statement-breakpoint
ALTER TABLE "channel_summary_versions" DROP CONSTRAINT IF EXISTS "channel_summary_versions_summary_fk", ADD CONSTRAINT "channel_summary_versions_summary_fk" FOREIGN KEY ("workspace_id","team_id","channel_id") REFERENCES "public"."channel_summaries"("workspace_id","team_id","channel_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_summary_versions_made_idx" ON "channel_summary_versions" USING btree ("made_at");--> statement-breakpoint
-- The current version of each summary made before this migration, so its
-- history starts there.
INSERT INTO "channel_summary_versions" ("workspace_id", "team_id", "channel_id", "version", "made_at")
SELECT "workspace_id", "team_id", "channel_id", "version", "updated_at" FROM "channel_summaries"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "conversation_judgments" DROP CONSTRAINT IF EXISTS "conversation_judgments_summary_check", ADD CONSTRAINT "conversation_judgments_summary_check" CHECK ("conversation_judgments"."summary" IS NULL OR ("conversation_judgments"."summary" IN ('written','skipped','copied','invalid','lost') AND "conversation_judgments"."grade" = 'buffer_m1' AND "conversation_judgments"."outcome" = 'judged')) NOT VALID;
