CREATE TABLE "workspace_mcp_connections" (
	"server_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"state" text DEFAULT 'none' NOT NULL,
	"reauth_reason" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"pending_flow_id" uuid,
	"pending_state_sha256" "bytea",
	"pending_started_by_user_id" uuid,
	"pending_expires_at" timestamp with time zone,
	"connected_by_user_id" uuid,
	"connected_at" timestamp with time zone,
	"access_expires_at" timestamp with time zone,
	"granted_scope" text,
	"refresh_failed_at" timestamp with time zone,
	CONSTRAINT "workspace_mcp_connections_pk" PRIMARY KEY("server_id","subject"),
	CONSTRAINT "workspace_mcp_connections_subject_check" CHECK ("workspace_mcp_connections"."subject" = 'workspace'),
	CONSTRAINT "workspace_mcp_connections_state_check" CHECK ("workspace_mcp_connections"."state" IN ('none', 'active', 'needs_reauth')),
	CONSTRAINT "workspace_mcp_connections_reauth_check" CHECK (("workspace_mcp_connections"."state" = 'needs_reauth') = ("workspace_mcp_connections"."reauth_reason" IS NOT NULL) AND ("workspace_mcp_connections"."reauth_reason" IS NULL OR "workspace_mcp_connections"."reauth_reason" IN ('invalid_grant', 'invalid_client', 'scope_widened', 'expired'))),
	CONSTRAINT "workspace_mcp_connections_pending_check" CHECK (("workspace_mcp_connections"."pending_flow_id" IS NULL) = ("workspace_mcp_connections"."pending_state_sha256" IS NULL) AND ("workspace_mcp_connections"."pending_flow_id" IS NULL) = ("workspace_mcp_connections"."pending_started_by_user_id" IS NULL) AND ("workspace_mcp_connections"."pending_flow_id" IS NULL) = ("workspace_mcp_connections"."pending_expires_at" IS NULL)),
	CONSTRAINT "workspace_mcp_connections_connected_check" CHECK ("workspace_mcp_connections"."state" = 'none' OR "workspace_mcp_connections"."connected_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "workspace_mcp_servers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_kind" text NOT NULL,
	"oauth" jsonb,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_skipped" integer DEFAULT 0 NOT NULL,
	"tools_read_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_mcp_servers_name_uniq" UNIQUE("workspace_id","name"),
	CONSTRAINT "workspace_mcp_servers_name_check" CHECK ("workspace_mcp_servers"."name" ~ '^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$' AND "workspace_mcp_servers"."name" NOT IN ('github', 'browser')),
	CONSTRAINT "workspace_mcp_servers_auth_kind_check" CHECK ("workspace_mcp_servers"."auth_kind" IN ('oauth', 'bearer')),
	CONSTRAINT "workspace_mcp_servers_oauth_check" CHECK (("workspace_mcp_servers"."auth_kind" = 'oauth') = ("workspace_mcp_servers"."oauth" IS NOT NULL)),
	CONSTRAINT "workspace_mcp_servers_tools_check" CHECK (jsonb_typeof("workspace_mcp_servers"."tools") = 'array' AND jsonb_array_length("workspace_mcp_servers"."tools") <= 200 AND "workspace_mcp_servers"."tools_skipped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_mcp_connections" ADD CONSTRAINT "workspace_mcp_connections_server_id_workspace_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."workspace_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_mcp_connections_connected_by_idx" ON "workspace_mcp_connections" USING btree ("connected_by_user_id");