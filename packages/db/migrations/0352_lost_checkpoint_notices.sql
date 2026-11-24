CREATE TABLE "lost_checkpoint_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"forgotten_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_ids" jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	CONSTRAINT "lost_checkpoint_notices_session_ids_check" CHECK (jsonb_typeof("lost_checkpoint_notices"."session_ids") = 'array'),
	CONSTRAINT "lost_checkpoint_notices_closed_check" CHECK ("lost_checkpoint_notices"."closed_by" IS NULL OR "lost_checkpoint_notices"."closed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "lost_checkpoint_notices" ADD CONSTRAINT "lost_checkpoint_notices_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;