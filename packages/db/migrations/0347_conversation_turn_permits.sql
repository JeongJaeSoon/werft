-- The permits of running conversation turns, one row per turn: the hash of
-- the token the runtime sends with each provider request and what each
-- request may use. A new, empty table; no existing row changes. Removed with
-- its turn. Every statement may run again.
CREATE TABLE IF NOT EXISTS "conversation_turn_permits" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"root_kind" text NOT NULL,
	"requester_user_id" uuid,
	"connection_id" text NOT NULL,
	"path" text NOT NULL,
	"model" text NOT NULL,
	"max_tokens" integer NOT NULL,
	"max_request_bytes" integer NOT NULL,
	"call_key" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turn_permits_root_kind_check" CHECK ("conversation_turn_permits"."root_kind" IN ('user','key','slack_bot','none')),
	CONSTRAINT "conversation_turn_permits_limits_check" CHECK ("conversation_turn_permits"."max_tokens" >= 1 AND "conversation_turn_permits"."max_request_bytes" >= 1 AND "conversation_turn_permits"."calls" >= 0 AND "conversation_turn_permits"."call_key" ~ '^[A-Za-z0-9_-]{1,128}:m2$'),
	CONSTRAINT "conversation_turn_permits_refusal_check" CHECK ("conversation_turn_permits"."refusal" IN ('budget','concurrency','turn_limit'))
);
--> statement-breakpoint
ALTER TABLE "conversation_turn_permits" DROP CONSTRAINT IF EXISTS "conversation_turn_permits_turn_fk", ADD CONSTRAINT "conversation_turn_permits_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_turn_permits_token_uniq" ON "conversation_turn_permits" USING btree ("token_hash");