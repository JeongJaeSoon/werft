-- migrate:no-transaction
-- The `estimated` resolution: the reconciler closes a reservation of unknown
-- end at what it held once its turn ended and its call can no longer run.
-- No column changes and no row is rewritten; an older image never writes the
-- value. The CHECK is added NOT VALID and validated in a statement of its own,
-- so no scan holds a write lock. Every statement may run again.
ALTER TABLE "budget_reservations" DROP CONSTRAINT IF EXISTS "budget_reservations_resolution_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_resolution_check" CHECK (("budget_reservations"."state" = 'resolved') = ("budget_reservations"."resolution" IS NOT NULL) AND "budget_reservations"."resolution" IN ('spent','refunded','estimated')) NOT VALID;--> statement-breakpoint
ALTER TABLE "budget_reservations" VALIDATE CONSTRAINT "budget_reservations_resolution_check";
