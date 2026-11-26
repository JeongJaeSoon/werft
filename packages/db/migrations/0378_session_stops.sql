-- What a stop did (queued input cancelled, the turn it interrupted), kept
-- under the stop request's key so a retry of the request replays it instead
-- of cancelling or interrupting work that started after it. A new table: no
-- rows to backfill, nothing reads it but the stop. Every statement may run
-- again.
CREATE TABLE IF NOT EXISTS "session_stops" (
	"session_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"cancelled" integer NOT NULL,
	"running_turn_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_stops_session_id_idempotency_key_pk" PRIMARY KEY("session_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "session_stops" DROP CONSTRAINT IF EXISTS "session_stops_session_id_sessions_id_fk", ADD CONSTRAINT "session_stops_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;