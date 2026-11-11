ALTER TABLE "sessions" ADD COLUMN "caller_limit" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "caller_limit_digest" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "caller_channel" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "caller_limit_digest" text;