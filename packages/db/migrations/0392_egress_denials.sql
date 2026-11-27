-- migrate:no-transaction
-- Each statement commits on its own and may run again. In one transaction
-- the foreign keys' locks on sessions, attempts and turns and the CHECK swap's
-- lock on worker_credentials are held together, and live claims, replays and
-- releases take those tables in both orders, so they could deadlock with it.
-- Here no statement contends for more than one live table.
CREATE TABLE IF NOT EXISTS "egress_denials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_id" text NOT NULL,
	"turn_id" bigint,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_denials_turn_host_key" UNIQUE NULLS NOT DISTINCT("attempt_id","turn_id","host","port"),
	CONSTRAINT "egress_denials_port_check" CHECK ("egress_denials"."port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
ALTER TABLE "egress_denials" DROP CONSTRAINT IF EXISTS "egress_denials_session_id_sessions_id_fk", ADD CONSTRAINT "egress_denials_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_denials" DROP CONSTRAINT IF EXISTS "egress_denials_attempt_id_attempts_id_fk", ADD CONSTRAINT "egress_denials_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_denials" DROP CONSTRAINT IF EXISTS "egress_denials_turn_id_turns_id_fk", ADD CONSTRAINT "egress_denials_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_credentials" DROP CONSTRAINT IF EXISTS "worker_credentials_purpose_check", ADD CONSTRAINT "worker_credentials_purpose_check" CHECK ("worker_credentials"."purpose" IN ('gateway', 'provider', 'repository', 'object_store', 'mcp', 'packages', 'egress_report'));
