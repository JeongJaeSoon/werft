CREATE TABLE "agent_mcp_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"server" text,
	"allowed_tools" jsonb NOT NULL,
	"credential_refs" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_settings_allowed_tools_check" CHECK (jsonb_typeof("agent_mcp_settings"."allowed_tools") = 'array' AND NOT jsonb_path_exists("agent_mcp_settings"."allowed_tools", '$[*] ? (@.type() != "string")') AND ("agent_mcp_settings"."server" IS NOT NULL OR jsonb_array_length("agent_mcp_settings"."allowed_tools") = 0) AND ("agent_mcp_settings"."server" IS NULL OR NOT jsonb_path_exists("agent_mcp_settings"."allowed_tools", '$[*] ? (!(@ starts with $p) || @ == $p)', jsonb_build_object('p', 'mcp__' || "agent_mcp_settings"."server" || '__')))),
	CONSTRAINT "agent_mcp_settings_credential_refs_check" CHECK (jsonb_typeof("agent_mcp_settings"."credential_refs") = 'array' AND jsonb_array_length("agent_mcp_settings"."credential_refs") <= 32 AND NOT jsonb_path_exists("agent_mcp_settings"."credential_refs", '$[*] ? (@.type() != "string")') AND NOT jsonb_path_exists("agent_mcp_settings"."credential_refs", '$[*] ? (!(@ like_regex "^[a-z0-9][a-z0-9._:/-]{0,127}$"))')),
	CONSTRAINT "agent_mcp_settings_server_check" CHECK ("agent_mcp_settings"."server" IS NULL OR "agent_mcp_settings"."server" ~ '^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mcp_start" jsonb;--> statement-breakpoint
ALTER TABLE "agent_mcp_settings" ADD CONSTRAINT "agent_mcp_settings_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;