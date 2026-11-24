-- migrate:no-transaction
-- The address a setup link makes an owner for, and the id and time the
-- bootstrap receipt names. Additive: id and email are nullable with no default,
-- so a link issued before this (or by an older image in the support window)
-- keeps working for any address; created_at's default is evaluated once and
-- stored, so no row is rewritten. Every statement may run again: a failure part
-- way leaves the ones before it committed, and the next run starts from the top.
ALTER TABLE "setup_links" ADD COLUMN IF NOT EXISTS "id" uuid;--> statement-breakpoint
ALTER TABLE "setup_links" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "setup_links" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
