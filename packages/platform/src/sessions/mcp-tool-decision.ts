import { MCP_TOOL_PREFIX } from "@werft-ai/contracts";

/**
 * The one deny-first rule for a remote MCP server's tools. The claim's tool
 * set (what the worker lists) and the egress's `tools/call` verdict both
 * come from here, so they cannot drift.
 *
 * A tool is visible when some allow source names it, it belongs to `server`,
 * and no deny source names it. Every deny source (release `deny` pins,
 * release snapshot `mcp_deny`, saved engine rules) wins over every allow.
 * A match is exact: a prefix would deny a server's other tools.
 */
export function visibleMcpTools(
  server: string,
  allow: readonly string[],
  ...denies: readonly (readonly string[])[]
): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  const denied = new Set(denies.flat());
  return [
    ...new Set(
      allow.filter(
        (tool) =>
          tool.startsWith(prefix) &&
          tool.length > prefix.length &&
          !denied.has(tool),
      ),
    ),
  ].sort();
}

/** Whether a `tools/call` to `tool` on `server` may pass, given the visible set. */
export function mcpToolPermitted(
  visible: readonly string[],
  server: string,
  tool: string,
): boolean {
  return visible.includes(`${MCP_TOOL_PREFIX}${server}__${tool}`);
}
