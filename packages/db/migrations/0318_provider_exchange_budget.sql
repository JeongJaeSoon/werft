ALTER TABLE "provider_exchanges" ADD COLUMN "budget_root_kind" text;--> statement-breakpoint
ALTER TABLE "provider_exchanges" ADD COLUMN "budget_account_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_exchanges" ADD CONSTRAINT "provider_exchanges_budget_root_kind_check" CHECK ("provider_exchanges"."budget_root_kind" IN ('user','key','none'));--> statement-breakpoint
ALTER TABLE "provider_exchanges" ADD CONSTRAINT "provider_exchanges_budget_account_check" CHECK ("provider_exchanges"."budget_account_id" IS NULL OR "provider_exchanges"."budget_root_kind" IS NOT NULL);