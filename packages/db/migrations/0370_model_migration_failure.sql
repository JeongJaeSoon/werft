-- The last automatic model move of an agent that failed: the active release
-- it tried to move from, why, and when. Nullable columns, no default, so no
-- row is rewritten.
ALTER TABLE "agents" ADD COLUMN "model_migration_failed_release_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model_migration_failure" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model_migration_failed_at" timestamp with time zone;