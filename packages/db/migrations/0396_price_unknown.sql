-- migrate:no-transaction
-- A model neither price table names is priced from the LiteLLM snapshot
-- (priced_by 'litellm'), and one nothing prices at the highest known rate
-- (priced_by 'unknown'; 'fallback' stays for rows from before). A call records
-- the model its request asked for (request_model), the price data that
-- settled it (price_version) and whether either model is one nothing prices
-- (price_unknown): the tokens of those calls are what a session's limit on
-- tokens of unknown price counts. An open exchange records what priced its
-- reserve and with which price data.
--
-- Nullable columns and one with a constant default, so no row is rewritten.
-- An older image names its columns when it writes and reads, and writes only
-- 'table', 'fallback' and 'unmetered': its rows have price_unknown false and
-- the rest null, and it reads the new priced_by values as the text they are.
-- The CHECK is widened NOT VALID and validated in a statement of its own, so
-- no scan holds a write lock. The index holds only the calls marked unknown,
-- which an open sums per session, and is built CONCURRENTLY: provider_usage
-- is written on every call. Every statement may run again.
ALTER TABLE "provider_exchanges" ADD COLUMN IF NOT EXISTS "priced_by" text;--> statement-breakpoint
ALTER TABLE "provider_exchanges" ADD COLUMN IF NOT EXISTS "price_version" text;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "request_model" text;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "price_version" text;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD COLUMN IF NOT EXISTS "price_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_usage" DROP CONSTRAINT IF EXISTS "provider_usage_priced_by_check";--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_priced_by_check" CHECK ("provider_usage"."priced_by" IN ('table', 'litellm', 'unknown', 'fallback', 'unmetered')) NOT VALID;--> statement-breakpoint
ALTER TABLE "provider_usage" VALIDATE CONSTRAINT "provider_usage_priced_by_check";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "provider_usage_session_price_unknown_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY "provider_usage_session_price_unknown_idx" ON "provider_usage" USING btree ("session_id") WHERE "provider_usage"."price_unknown";
