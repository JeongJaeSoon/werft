-- The ledger of provider calls the egress proxy opened and no usage report
-- has settled yet (docs/contributing/decisions/provider-usage-ledger.md).
-- Observation only: no limit reads it. A new table with no foreign keys, so
-- it locks nothing else and an older build simply never touches it.
CREATE TABLE "provider_exchanges" (
	"exchange_id" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"reserve" jsonb NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"noticed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "provider_exchanges_lease_idx" ON "provider_exchanges" USING btree ("lease_expires_at");