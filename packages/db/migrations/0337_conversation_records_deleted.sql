-- migrate:no-transaction
-- An admin's delete of a conversation's records: the conversation row keeps
-- when and who, and each delete mark why it was made (Slack, or that admin
-- delete; every check treats both alike). The new columns are nullable or
-- take a constant default, so no row is rewritten. conversations only grows,
-- so its constraints are added NOT VALID and validated in their own
-- statements, whose scans hold no write lock. Every statement may run again.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "records_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "records_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "deleted_sources" ADD COLUMN IF NOT EXISTS "reason" text DEFAULT 'slack_deleted' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_records_deleted_by_fk", ADD CONSTRAINT "conversations_records_deleted_by_fk" FOREIGN KEY ("workspace_id","records_deleted_by_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_records_deleted_by_fk";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_records_deleted_check", ADD CONSTRAINT "conversations_records_deleted_check" CHECK (("conversations"."records_deleted_at" IS NULL) = ("conversations"."records_deleted_by_user_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_records_deleted_check";--> statement-breakpoint
ALTER TABLE "deleted_sources" DROP CONSTRAINT IF EXISTS "deleted_sources_reason_check", ADD CONSTRAINT "deleted_sources_reason_check" CHECK ("deleted_sources"."reason" IN ('slack_deleted','admin_deleted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "deleted_sources" VALIDATE CONSTRAINT "deleted_sources_reason_check";