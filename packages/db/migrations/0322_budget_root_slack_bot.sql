ALTER TABLE "budget_reservations" DROP CONSTRAINT "budget_reservations_root_kind_check";--> statement-breakpoint
ALTER TABLE "provider_exchanges" DROP CONSTRAINT "provider_exchanges_budget_root_kind_check";--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_root_kind_check" CHECK ("budget_reservations"."root_kind" IN ('user','key','slack_bot','none'));--> statement-breakpoint
ALTER TABLE "provider_exchanges" ADD CONSTRAINT "provider_exchanges_budget_root_kind_check" CHECK ("provider_exchanges"."budget_root_kind" IN ('user','key','slack_bot','none'));