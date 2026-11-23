CREATE TABLE "conversation_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"root_kind" text NOT NULL,
	"requester_user_id" uuid,
	"connection_id" text NOT NULL,
	"path" text NOT NULL,
	"model" text NOT NULL,
	"max_tokens" integer NOT NULL,
	"max_request_bytes" integer NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"exchange_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"usage" jsonb,
	"cost_usd" numeric(14, 6),
	"tokens" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "conversation_calls_root_kind_check" CHECK ("conversation_calls"."root_kind" IN ('user','key','slack_bot','none')),
	CONSTRAINT "conversation_calls_state_check" CHECK ("conversation_calls"."state" IN ('reserved','in_flight','settled','released')),
	CONSTRAINT "conversation_calls_limits_check" CHECK ("conversation_calls"."max_tokens" > 0 AND "conversation_calls"."max_request_bytes" > 0),
	CONSTRAINT "conversation_calls_state_columns_check" CHECK (CASE "conversation_calls"."state"
        WHEN 'reserved' THEN "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'in_flight' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NULL AND "conversation_calls"."usage" IS NULL
        WHEN 'settled' THEN "conversation_calls"."exchange_id" IS NOT NULL AND "conversation_calls"."started_at" IS NOT NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NOT NULL
        ELSE "conversation_calls"."exchange_id" IS NULL AND "conversation_calls"."started_at" IS NULL AND "conversation_calls"."ended_at" IS NOT NULL AND "conversation_calls"."usage" IS NULL
      END),
	CONSTRAINT "conversation_calls_settled_check" CHECK (("conversation_calls"."state" = 'settled') = ("conversation_calls"."cost_usd" IS NOT NULL AND "conversation_calls"."tokens" IS NOT NULL)),
	CONSTRAINT "conversation_calls_nonneg_check" CHECK (("conversation_calls"."cost_usd" >= 0 AND "conversation_calls"."cost_usd" <> 'NaN') AND "conversation_calls"."tokens" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD CONSTRAINT "conversation_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_calls" ADD CONSTRAINT "conversation_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_calls_token_uniq" ON "conversation_calls" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_calls_exchange_uniq" ON "conversation_calls" USING btree ("exchange_id");--> statement-breakpoint
CREATE INDEX "conversation_calls_reserved_expiry_idx" ON "conversation_calls" USING btree ("expires_at") WHERE "conversation_calls"."state" = 'reserved';