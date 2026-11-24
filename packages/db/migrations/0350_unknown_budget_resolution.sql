-- migrate:no-transaction
-- An operator closes a budget reservation of unknown end (unknown_at): the
-- new state `resolved` on budget_reservations, with `resolution` (spent or
-- refunded) and settled_* as what it charged, and on conversation_calls for
-- the call in flight it belonged to. budget_adjustments, a new empty table,
-- keeps the one adjustment a late report of a resolved call adds, by call
-- id. The new column is nullable with no default, so no row is rewritten.
-- Each changed CHECK is dropped and added again NOT VALID in one statement,
-- then validated in its own, whose scan holds no write lock; every existing
-- row passes, as none is resolved. An older image settling a resolved row
-- breaks the resolution check and fails that report, which is retried.
-- Every statement may run again.
CREATE TABLE IF NOT EXISTS "budget_adjustments" (
	"call_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"reported_cost_usd" numeric(14, 6) NOT NULL,
	"reported_tokens" bigint NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"tokens" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_adjustments_amount_check" CHECK (("budget_adjustments"."reported_cost_usd" >= 0 AND "budget_adjustments"."reported_cost_usd" <> 'NaN') AND "budget_adjustments"."reported_tokens" BETWEEN 0 AND 9007199254740991 AND "budget_adjustments"."cost_usd" <> 'NaN' AND "budget_adjustments"."tokens" BETWEEN -9007199254740991 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "budget_adjustments" DROP CONSTRAINT IF EXISTS "budget_adjustments_call_id_budget_reservations_call_id_fk", ADD CONSTRAINT "budget_adjustments_call_id_budget_reservations_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."budget_reservations"("call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_adjustments" DROP CONSTRAINT IF EXISTS "budget_adjustments_workspace_id_workspaces_id_fk", ADD CONSTRAINT "budget_adjustments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_adjustments" DROP CONSTRAINT IF EXISTS "budget_adjustments_account_id_budget_accounts_id_fk", ADD CONSTRAINT "budget_adjustments_account_id_budget_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_adjustments_account_idx" ON "budget_adjustments" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN IF NOT EXISTS "resolution" text;--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_state_check", ADD CONSTRAINT "budget_reservations_state_check" CHECK ("budget_reservations"."state" IN ('reserved','settled','released','resolved')) NOT VALID;--> statement-breakpoint
ALTER TABLE "budget_reservations" VALIDATE CONSTRAINT "budget_reservations_state_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_settled_check", ADD CONSTRAINT "budget_reservations_settled_check" CHECK (CASE WHEN "budget_reservations"."state" IN ('settled', 'resolved') THEN "budget_reservations"."settled_cost_usd" IS NOT NULL AND "budget_reservations"."settled_tokens" IS NOT NULL ELSE "budget_reservations"."settled_cost_usd" IS NULL AND "budget_reservations"."settled_tokens" IS NULL END) NOT VALID;--> statement-breakpoint
ALTER TABLE "budget_reservations" VALIDATE CONSTRAINT "budget_reservations_settled_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_resolution_check", ADD CONSTRAINT "budget_reservations_resolution_check" CHECK (("budget_reservations"."state" = 'resolved') = ("budget_reservations"."resolution" IS NOT NULL) AND "budget_reservations"."resolution" IN ('spent','refunded')) NOT VALID;--> statement-breakpoint
ALTER TABLE "budget_reservations" VALIDATE CONSTRAINT "budget_reservations_resolution_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_state_check", ADD CONSTRAINT "conversation_calls_state_check" CHECK ("conversation_calls"."state" IN ('reserved','in_flight','settled','released','resolved')) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_state_check";--> statement-breakpoint
ALTER TABLE "conversation_calls" DROP CONSTRAINT IF EXISTS "conversation_calls_state_columns_check", ADD CONSTRAINT "conversation_calls_state_columns_check" CHECK (CASE "conversation_calls"."state"
        WHEN 'reserved' THEN "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'in_flight' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'settled' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NOT NULL
        WHEN 'resolved' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
        ELSE "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
      END) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_calls" VALIDATE CONSTRAINT "conversation_calls_state_columns_check";
