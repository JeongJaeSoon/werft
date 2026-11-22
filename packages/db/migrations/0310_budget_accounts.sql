CREATE TABLE "budget_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"spent_cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"spent_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_cost_usd" numeric(14, 6) DEFAULT 0 NOT NULL,
	"reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_accounts_owner_period_key" UNIQUE("workspace_id","owner_kind","owner_id","period_start"),
	CONSTRAINT "budget_accounts_owner_kind_check" CHECK ("budget_accounts"."owner_kind" IN ('user','team')),
	CONSTRAINT "budget_accounts_period_check" CHECK (extract(day from "budget_accounts"."period_start") = 1),
	CONSTRAINT "budget_accounts_nonneg_check" CHECK ("budget_accounts"."spent_cost_usd" >= 0 AND "budget_accounts"."spent_tokens" >= 0 AND "budget_accounts"."reserved_cost_usd" >= 0 AND "budget_accounts"."reserved_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_limits" (
	"workspace_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"subject_id" uuid,
	"cost_usd" numeric(14, 6),
	"tokens" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_limits_subject_key" UNIQUE NULLS NOT DISTINCT("workspace_id","subject","subject_id"),
	CONSTRAINT "budget_limits_subject_check" CHECK ("budget_limits"."subject" IN ('person_default','user','team')),
	CONSTRAINT "budget_limits_subject_id_check" CHECK (("budget_limits"."subject" = 'person_default') = ("budget_limits"."subject_id" IS NULL)),
	CONSTRAINT "budget_limits_nonneg_check" CHECK ("budget_limits"."cost_usd" >= 0 AND "budget_limits"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"call_id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"root_kind" text NOT NULL,
	"unmetered" boolean NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"tokens" bigint NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"settled_cost_usd" numeric(14, 6),
	"settled_tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "budget_reservations_root_kind_check" CHECK ("budget_reservations"."root_kind" IN ('user','key','none')),
	CONSTRAINT "budget_reservations_state_check" CHECK ("budget_reservations"."state" IN ('reserved','settled','released')),
	CONSTRAINT "budget_reservations_ended_check" CHECK (("budget_reservations"."state" = 'reserved') = ("budget_reservations"."ended_at" IS NULL)),
	CONSTRAINT "budget_reservations_settled_check" CHECK (("budget_reservations"."state" = 'settled') = ("budget_reservations"."settled_cost_usd" IS NOT NULL AND "budget_reservations"."settled_tokens" IS NOT NULL)),
	CONSTRAINT "budget_reservations_nonneg_check" CHECK ("budget_reservations"."cost_usd" >= 0 AND "budget_reservations"."tokens" >= 0 AND "budget_reservations"."settled_cost_usd" >= 0 AND "budget_reservations"."settled_tokens" >= 0),
	CONSTRAINT "budget_reservations_unmetered_check" CHECK (NOT "budget_reservations"."unmetered" OR ("budget_reservations"."cost_usd" = 0 AND coalesce("budget_reservations"."settled_cost_usd", 0) = 0))
);
--> statement-breakpoint
ALTER TABLE "budget_accounts" ADD CONSTRAINT "budget_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_limits" ADD CONSTRAINT "budget_limits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_account_id_budget_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_account_idx" ON "budget_reservations" USING btree ("account_id");