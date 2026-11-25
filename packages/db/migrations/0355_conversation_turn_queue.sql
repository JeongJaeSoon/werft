-- The conversation turn queue, moved out of the API process's memory: one
-- row per attempt at one input, its turn sealed while it waits, ids, times
-- and how it ended otherwise. The table is new and empty, so its constraints
-- and indexes are made with it. Every statement may run again.
CREATE TABLE IF NOT EXISTS "conversation_turn_queue" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"input_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"topic_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"state" text NOT NULL,
	"take_by" timestamp with time zone NOT NULL,
	"take_ms" integer NOT NULL,
	"usable_until" timestamp with time zone,
	"turn_nonce" "bytea",
	"turn_ciphertext" "bytea",
	"lease_id" uuid,
	"runtime_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"outcome" jsonb,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_turn_queue_attempt_uniq" UNIQUE("input_id","attempt"),
	CONSTRAINT "conversation_turn_queue_state_check" CHECK ("conversation_turn_queue"."attempt" >= 1 AND "conversation_turn_queue"."take_ms" >= 0 AND CASE "conversation_turn_queue"."state"
        WHEN 'queued' THEN "conversation_turn_queue"."turn_nonce" IS NOT NULL AND "conversation_turn_queue"."turn_ciphertext" IS NOT NULL AND "conversation_turn_queue"."lease_id" IS NULL AND "conversation_turn_queue"."runtime_id" IS NULL AND "conversation_turn_queue"."lease_expires_at" IS NULL AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NULL
        WHEN 'leased' THEN "conversation_turn_queue"."turn_nonce" IS NULL AND "conversation_turn_queue"."turn_ciphertext" IS NULL AND "conversation_turn_queue"."lease_id" IS NOT NULL AND "conversation_turn_queue"."runtime_id" IS NOT NULL AND "conversation_turn_queue"."lease_expires_at" IS NOT NULL AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NULL
        WHEN 'ended' THEN "conversation_turn_queue"."turn_nonce" IS NULL AND "conversation_turn_queue"."turn_ciphertext" IS NULL AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."runtime_id" IS NULL) AND ("conversation_turn_queue"."lease_id" IS NULL) = ("conversation_turn_queue"."lease_expires_at" IS NULL) AND "conversation_turn_queue"."outcome" IS NOT NULL AND "conversation_turn_queue"."ended_at" IS NOT NULL
        WHEN 'forgotten' THEN "conversation_turn_queue"."turn_nonce" IS NULL AND "conversation_turn_queue"."turn_ciphertext" IS NULL AND "conversation_turn_queue"."lease_id" IS NULL AND "conversation_turn_queue"."runtime_id" IS NULL AND "conversation_turn_queue"."lease_expires_at" IS NULL AND "conversation_turn_queue"."outcome" IS NULL AND "conversation_turn_queue"."ended_at" IS NOT NULL
        ELSE false
      END)
);
--> statement-breakpoint
ALTER TABLE "conversation_turn_queue" DROP CONSTRAINT IF EXISTS "conversation_turn_queue_turn_fk", ADD CONSTRAINT "conversation_turn_queue_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."conversation_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turn_queue_open_idx" ON "conversation_turn_queue" USING btree ("seq") WHERE "conversation_turn_queue"."state" IN ('queued', 'leased');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_turn_queue_topic_idx" ON "conversation_turn_queue" USING btree ("topic_id","ended_at");