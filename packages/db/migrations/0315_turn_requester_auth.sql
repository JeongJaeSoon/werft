ALTER TABLE "tool_call_audits" ADD COLUMN "requester_kind" text;--> statement-breakpoint
ALTER TABLE "tool_call_audits" ADD COLUMN "requester_id" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "requester_auth" jsonb;