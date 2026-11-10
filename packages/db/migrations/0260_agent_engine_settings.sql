CREATE TABLE "agent_engine_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_mode" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_engine_settings_permissions_check" CHECK (jsonb_typeof("agent_engine_settings"."permissions") = 'object'
    AND NOT jsonb_path_exists("agent_engine_settings"."permissions", 'strict $.keyvalue() ? (!(@.key == "allow" || @.key == "ask" || @.key == "deny"))')
    AND NOT jsonb_path_exists("agent_engine_settings"."permissions", 'strict $.* ? (@.type() != "array")')
    AND NOT jsonb_path_exists("agent_engine_settings"."permissions", 'strict $.* ? (@.size() > 64)')
    AND NOT jsonb_path_exists("agent_engine_settings"."permissions", 'strict $.*[*] ? (@.type() != "string")')
    AND NOT jsonb_path_exists("agent_engine_settings"."permissions", 'strict $.*[*] ? (@ == "" || @ like_regex "^(.{128}){2}." flag "s")')),
	CONSTRAINT "agent_engine_settings_auto_mode_check" CHECK (jsonb_typeof("agent_engine_settings"."auto_mode") = 'object'
    AND NOT jsonb_path_exists("agent_engine_settings"."auto_mode", 'strict $.keyvalue() ? (!(@.key == "allow" || @.key == "soft_deny" || @.key == "hard_deny" || @.key == "environment"))')
    AND NOT jsonb_path_exists("agent_engine_settings"."auto_mode", 'strict $.* ? (@.type() != "array")')
    AND NOT jsonb_path_exists("agent_engine_settings"."auto_mode", 'strict $.* ? (@.size() > 64)')
    AND NOT jsonb_path_exists("agent_engine_settings"."auto_mode", 'strict $.*[*] ? (@.type() != "string")')
    AND NOT jsonb_path_exists("agent_engine_settings"."auto_mode", 'strict $.*[*] ? (@ == "" || @ like_regex "^(.{128}){8}." flag "s")')),
	CONSTRAINT "agent_engine_settings_revision_check" CHECK ("agent_engine_settings"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_engine_settings" ADD CONSTRAINT "agent_engine_settings_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;