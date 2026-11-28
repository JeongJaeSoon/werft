-- migrate:no-transaction
-- A workspace MCP server may take no credential (auth_kind 'none'): nothing
-- is stored for it and its calls go without an Authorization header. The
-- CHECK only widens, so every row before passes it. It is swapped in one
-- statement (no moment without it) as NOT VALID, then validated in a
-- statement of its own, outside a transaction, so the scan holds no lock that
-- stops reads or writes. An image that knows the response schema's open
-- auth_kind lists a 'none' row as a kind it does not support and sends
-- nothing with it. Every statement may run again.
ALTER TABLE "workspace_mcp_servers" DROP CONSTRAINT IF EXISTS "workspace_mcp_servers_auth_kind_check", ADD CONSTRAINT "workspace_mcp_servers_auth_kind_check" CHECK ("workspace_mcp_servers"."auth_kind" IN ('oauth', 'bearer', 'none')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" VALIDATE CONSTRAINT "workspace_mcp_servers_auth_kind_check";
