CREATE TABLE "session_repository_pins" (
	"session_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"git_commit" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_repository_pins_session_id_repository_id_pk" PRIMARY KEY("session_id","repository_id"),
	CONSTRAINT "session_repository_pins_commit_check" CHECK ("session_repository_pins"."git_commit" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
ALTER TABLE "session_repository_pins" ADD CONSTRAINT "session_repository_pins_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;