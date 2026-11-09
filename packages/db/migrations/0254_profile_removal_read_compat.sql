-- Both CHECKs are NOT VALID and never validated on purpose: every existing row
-- already satisfies them (the spec columns are all NULL, auto_mode takes its
-- default), so a validating scan would only hold the ACCESS EXCLUSIVE lock from
-- the ADD COLUMNs above until commit. New and updated rows are still checked.
ALTER TABLE "agent_releases" ADD COLUMN "runtime_spec" jsonb;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN "spec_source" jsonb;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN "spec_source_digest" text;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD COLUMN "spec_digest" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "model_families" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "auto_mode" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_releases" ADD CONSTRAINT "agent_releases_spec_check" CHECK (("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_source" IS NULL) AND ("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_source_digest" IS NULL) AND ("agent_releases"."runtime_spec" IS NULL) = ("agent_releases"."spec_digest" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_auto_mode_check" CHECK ("provider_connections"."auto_mode" IN ('supported', 'unsupported', 'unknown')) NOT VALID;