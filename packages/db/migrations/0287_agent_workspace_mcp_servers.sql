CREATE TABLE "agent_workspace_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workspace_mcp_servers_agent_id_server_id_pk" PRIMARY KEY("agent_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_mcp_start" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "agent_workspace_mcp_servers" ADD CONSTRAINT "agent_workspace_mcp_servers_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_mcp_servers" ADD CONSTRAINT "agent_workspace_mcp_servers_server_fk" FOREIGN KEY ("workspace_id","server_id") REFERENCES "public"."workspace_mcp_servers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_workspace_mcp_servers_server_idx" ON "agent_workspace_mcp_servers" USING btree ("server_id");