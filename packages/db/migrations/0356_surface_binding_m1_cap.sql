-- migrate:no-transaction
-- Each Slack channel binding's own cap on M1's judgments per hour (a1/S3),
-- set with its listening. A constant default needs no table rewrite in
-- PostgreSQL 11+, so every existing binding reads 12, the cap it had; the
-- check is added NOT VALID and validated in its own statement. Every
-- statement may run again.
ALTER TABLE "surface_bindings" ADD COLUMN IF NOT EXISTS "m1_judgments_per_hour" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT IF EXISTS "surface_bindings_m1_judgments_per_hour_check", ADD CONSTRAINT "surface_bindings_m1_judgments_per_hour_check" CHECK ("surface_bindings"."m1_judgments_per_hour" BETWEEN 1 AND 60) NOT VALID;--> statement-breakpoint
ALTER TABLE "surface_bindings" VALIDATE CONSTRAINT "surface_bindings_m1_judgments_per_hour_check";
