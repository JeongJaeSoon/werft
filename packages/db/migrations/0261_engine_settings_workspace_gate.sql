CREATE TABLE "engine_settings_gate" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"writes_open" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	CONSTRAINT "engine_settings_gate_single" CHECK ("engine_settings_gate"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_engine_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_mode" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_engine_settings_permissions_check" CHECK (jsonb_typeof("workspace_engine_settings"."permissions") = 'object'
    AND NOT jsonb_path_exists("workspace_engine_settings"."permissions", 'strict $.keyvalue() ? (!(@.key == "allow" || @.key == "ask" || @.key == "deny"))')
    AND NOT jsonb_path_exists("workspace_engine_settings"."permissions", 'strict $.* ? (@.type() != "array")')
    AND NOT jsonb_path_exists("workspace_engine_settings"."permissions", 'strict $.* ? (@.size() > 64)')
    AND NOT jsonb_path_exists("workspace_engine_settings"."permissions", 'strict $.*[*] ? (@.type() != "string")')
    AND NOT jsonb_path_exists("workspace_engine_settings"."permissions", 'strict $.*[*] ? (@ == "" || @ like_regex "^(.{128}){2}." flag "s")')),
	CONSTRAINT "workspace_engine_settings_auto_mode_check" CHECK (jsonb_typeof("workspace_engine_settings"."auto_mode") = 'object'
    AND NOT jsonb_path_exists("workspace_engine_settings"."auto_mode", 'strict $.keyvalue() ? (!(@.key == "allow" || @.key == "soft_deny" || @.key == "hard_deny" || @.key == "environment"))')
    AND NOT jsonb_path_exists("workspace_engine_settings"."auto_mode", 'strict $.* ? (@.type() != "array")')
    AND NOT jsonb_path_exists("workspace_engine_settings"."auto_mode", 'strict $.* ? (@.size() > 64)')
    AND NOT jsonb_path_exists("workspace_engine_settings"."auto_mode", 'strict $.*[*] ? (@.type() != "string")')
    AND NOT jsonb_path_exists("workspace_engine_settings"."auto_mode", 'strict $.*[*] ? (@ == "" || @ like_regex "^(.{128}){8}." flag "s")')),
	CONSTRAINT "workspace_engine_settings_revision_check" CHECK ("workspace_engine_settings"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_engine_settings" ADD COLUMN "admin_deny" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_engine_settings" ADD CONSTRAINT "workspace_engine_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_engine_settings" ADD CONSTRAINT "agent_engine_settings_admin_deny_check" CHECK (jsonb_typeof("agent_engine_settings"."admin_deny") = 'array');--> statement-breakpoint
INSERT INTO "engine_settings_gate" ("id") VALUES (1) ON CONFLICT DO NOTHING;
