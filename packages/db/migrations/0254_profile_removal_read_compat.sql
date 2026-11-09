-- migrate:no-transaction
-- Columns the profile removal reads before anything writes them. Each statement
-- commits on its own, so the ACCESS EXCLUSIVE lock of an ADD COLUMN is gone
-- before the CHECKs are added NOT VALID and validated in their own statements
-- (VALIDATE takes no write-blocking lock). Every statement may run again: a
-- failure part way leaves the earlier ones committed and the next run starts
-- from the top.
ALTER TABLE "agent_releases" ADD COLUMN IF NOT EXISTS "runtime_spec" jsonb;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN IF NOT EXISTS "spec_source" jsonb;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN IF NOT EXISTS "spec_source_digest" text;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN IF NOT EXISTS "spec_digest" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN IF NOT EXISTS "models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN IF NOT EXISTS "model_families" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN IF NOT EXISTS "auto_mode" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" DROP CONSTRAINT IF EXISTS "agent_releases_spec_check", ADD CONSTRAINT "agent_releases_spec_check" CHECK (("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_source" IS NULL) AND ("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_source_digest" IS NULL) AND ("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_digest" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_releases" VALIDATE CONSTRAINT "agent_releases_spec_check";--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT IF EXISTS "provider_connections_auto_mode_check", ADD CONSTRAINT "provider_connections_auto_mode_check" CHECK ("provider_connections"."auto_mode" IN ('supported', 'unsupported', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "provider_connections" VALIDATE CONSTRAINT "provider_connections_auto_mode_check";
