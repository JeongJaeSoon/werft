-- The exchange ledger starts judging budgets (provider-usage-ledger.md,
-- "2c-2"): a release marks a call the provider never billed, and a judgment
-- reads a session's unreleased rows.
ALTER TABLE "provider_exchanges" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "provider_exchanges_session_held_idx" ON "provider_exchanges" USING btree ("session_id") WHERE "provider_exchanges"."released_at" IS NULL;--> statement-breakpoint
-- Rows the observe-only ledger left with an expired lease include calls the
-- provider never billed, which nothing could release then; counted as
-- reservations they would hold their sessions forever. Rows still leased are
-- calls in flight and stay counted, judged at the transaction's start: the
-- ALTER above holds back their renewals while it waits for its lock.
DELETE FROM "provider_exchanges" WHERE "lease_expires_at" < now();
