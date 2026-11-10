ALTER TABLE "sessions" ADD COLUMN "usage_basis" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "usage_team_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "requester_kind" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "requester_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "usage_basis" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "usage_team_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "requester_kind" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "requester_id" text;