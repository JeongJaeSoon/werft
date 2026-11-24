-- migrate:no-transaction
-- What a conversation call is for, the bones of the judgment record: its
-- conversation and topic, its class (m1, m2, summary), the agent's active
-- release, and a key unique in the agent with an attempt per retry. Every
-- new column is nullable with no default, so no row is rewritten and an
-- older image goes on issuing rows with all of them empty. The constraints
-- are added NOT VALID and validated in their own statements, whose scans
-- hold no write lock. A topic the judgment buffer drops empties the call's
-- topic_id; the call stays. Every statement may run again.
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "call_class" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "release_id" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "call_key" text;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD COLUMN IF NOT EXISTS "attempt" integer;--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_conversation_fk", ADD CONSTRAINT "conversation_calls_conversation_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_conversation_fk";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_topic_fk", ADD CONSTRAINT "conversation_calls_topic_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."conversation_topics"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_topic_fk";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_release_fk", ADD CONSTRAINT "conversation_calls_release_fk" FOREIGN KEY ("agent_id","release_id") REFERENCES "public"."agent_releases"("agent_id","id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_release_fk";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_call_class_check", ADD CONSTRAINT "conversation_calls_call_class_check" CHECK ("conversation_calls"."call_class" IN ('m1','m2','summary')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_call_class_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_call_key_check", ADD CONSTRAINT "conversation_calls_call_key_check" CHECK (CASE WHEN "conversation_calls"."call_key" IS NULL
        THEN "conversation_calls"."conversation_id" IS NULL AND "conversation_calls"."topic_id" IS NULL AND "conversation_calls"."call_class" IS NULL AND "conversation_calls"."release_id" IS NULL AND "conversation_calls"."attempt" IS NULL
        ELSE "conversation_calls"."conversation_id" IS NOT NULL AND "conversation_calls"."call_class" IS NOT NULL AND "conversation_calls"."attempt" IS NOT NULL AND "conversation_calls"."attempt" >= 1 AND "conversation_calls"."call_key" ~ ('^[A-Za-z0-9_-]{1,128}:' || "conversation_calls"."call_class" || '$')
      END) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_call_key_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_call_key_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "conversation_calls_call_key_uniq" ON "conversation_calls" USING btree ("agent_id","call_key","attempt");--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "conversation_calls_topic_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "conversation_calls_topic_idx" ON "conversation_calls" USING btree ("topic_id") WHERE "conversation_calls"."topic_id" IS NOT NULL;
