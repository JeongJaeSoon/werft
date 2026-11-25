ALTER TABLE "channel_summaries" ADD COLUMN "fold_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_summaries" ADD COLUMN "fold_tried_at" timestamp with time zone;