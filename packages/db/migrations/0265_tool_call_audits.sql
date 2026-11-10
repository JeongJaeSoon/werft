CREATE TABLE "tool_call_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"workspace_id" uuid,
	"owner_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" bigint NOT NULL,
	"attempt_id" text NOT NULL,
	"call_key" text NOT NULL,
	"phase" text NOT NULL,
	"tool_use_id" text,
	"parent_tool_use_id" text,
	"tool_name" text NOT NULL,
	"mcp_server" text,
	"input_sha256" text,
	"input_bytes" integer,
	"decision" text NOT NULL,
	"basis" text NOT NULL,
	"agent_id" uuid,
	"agent_release_id" text,
	"actor_user_id" uuid,
	"principal_kind" text,
	"principal_id" text,
	"surface" text,
	"pending_request_id" text,
	"answered_by" jsonb,
	"answer_surface" text,
	"answer_decision_id" uuid,
	"source" text NOT NULL,
	"record_version" integer NOT NULL,
	CONSTRAINT "tool_call_audits_phase_check" CHECK ("tool_call_audits"."phase" IN ('asked', 'decided')),
	CONSTRAINT "tool_call_audits_decision_check" CHECK ("tool_call_audits"."decision" IN ('allow', 'deny', 'require_approval', 'unknown')),
	CONSTRAINT "tool_call_audits_phase_decision_check" CHECK (("tool_call_audits"."phase" = 'asked') = ("tool_call_audits"."decision" = 'require_approval')),
	CONSTRAINT "tool_call_audits_source_check" CHECK ("tool_call_audits"."source" IN ('platform', 'worker_report')),
	CONSTRAINT "tool_call_audits_principal_check" CHECK (("tool_call_audits"."principal_kind" IS NULL) = ("tool_call_audits"."principal_id" IS NULL)),
	CONSTRAINT "tool_call_audits_input_check" CHECK (("tool_call_audits"."input_sha256" IS NULL) = ("tool_call_audits"."input_bytes" IS NULL)),
	CONSTRAINT "tool_call_audits_surface_check" CHECK ("tool_call_audits"."surface" IS NULL OR "tool_call_audits"."surface" IN ('web','slack','api'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_audits_call_idx" ON "tool_call_audits" USING btree ("session_id","attempt_id","turn_id","call_key","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_audits_approval_once_idx" ON "tool_call_audits" USING btree ("pending_request_id") WHERE "tool_call_audits"."phase" = 'decided' AND "tool_call_audits"."basis" = 'approval';--> statement-breakpoint
CREATE INDEX "tool_call_audits_session_at_idx" ON "tool_call_audits" USING btree ("session_id","at");--> statement-breakpoint
CREATE INDEX "tool_call_audits_workspace_at_idx" ON "tool_call_audits" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "tool_call_audits_at_idx" ON "tool_call_audits" USING btree ("at");--> statement-breakpoint
CREATE FUNCTION "tool_call_audits_refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tool_call_audits is append-only';
END
$$;--> statement-breakpoint
CREATE TRIGGER "tool_call_audits_append_only" BEFORE UPDATE ON "tool_call_audits"
  FOR EACH ROW EXECUTE FUNCTION "tool_call_audits_refuse_update"();