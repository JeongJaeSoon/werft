ALTER TABLE "authz_decisions" ADD COLUMN "access_axis" text;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "turn_id" integer;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "via" jsonb;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "granted" jsonb;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "rule_mode" text;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "access_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "rule_position" integer;--> statement-breakpoint
ALTER TABLE "authz_decisions" ADD COLUMN "team_snapshot" jsonb;