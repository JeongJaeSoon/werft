-- A workspace MCP server may take no credential (auth_kind 'none'): nothing
-- is stored for it and its calls go without an Authorization header. The
-- CHECK only widens, so every row before passes it; it is added NOT VALID and
-- validated in a statement of its own, so no scan holds a write lock. An older
-- image lists a 'none' row as a kind it does not support and sends nothing
-- with it. Every statement may run again.
ALTER TABLE "workspace_mcp_servers" DROP CONSTRAINT IF EXISTS "workspace_mcp_servers_auth_kind_check";--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_auth_kind_check" CHECK ("workspace_mcp_servers"."auth_kind" IN ('oauth', 'bearer', 'none')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" VALIDATE CONSTRAINT "workspace_mcp_servers_auth_kind_check";
