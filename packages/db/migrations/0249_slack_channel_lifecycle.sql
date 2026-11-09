CREATE TABLE "slack_channel_lifecycle" (
	"installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"last_event_us" bigint NOT NULL,
	"last_join_us" bigint,
	"last_leave_us" bigint,
	CONSTRAINT "slack_channel_lifecycle_pk" PRIMARY KEY("installation_id","channel_id")
);
--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "approved_lifecycle_us" bigint;--> statement-breakpoint
ALTER TABLE "slack_channel_lifecycle" ADD CONSTRAINT "slack_channel_lifecycle_installation_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE no action ON UPDATE no action;