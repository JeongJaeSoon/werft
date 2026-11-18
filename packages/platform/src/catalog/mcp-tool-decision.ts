import { MCP_TOOL_PREFIX, mcpServerWildcard } from "@werft-ai/contracts";

/**
 * Whether a deny source blocks `tool`, a full `mcp__<server>__<tool>` name,
 * on `server`: by its whole name, or by `mcp__<server>__*`. The server is
 * the one the call goes to, never split out of the name, so the wildcard of
 * `docs_` does not reach the tool `_read` of `docs`.
 */
export function mcpToolDenied(
  denied: readonly string[],
  server: string,
  tool: string,
): boolean {
  return denied.includes(tool) || denied.includes(mcpServerWildcard(server));
}

/**
 * The one deny-first rule for a remote MCP server's tools. The claim's tool
 * set (what the worker lists) and the egress's `tools/call` verdict both
 * come from here, so they cannot drift.
 *
 * A tool is visible when some allow source names it, it belongs to `server`,
 * and no deny source blocks it (`mcpToolDenied`). Every deny source (release
 * `deny` pins, release snapshot `mcp_deny`) wins over
 * every allow. An allow is matched by whole name only.
 */
export function visibleMcpTools(
  server: string,
  allow: readonly string[],
  ...denies: readonly (readonly string[])[]
): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  const denied = denies.flat();
  return [
    ...new Set(
      allow.filter(
        (tool) =>
          tool.startsWith(prefix) &&
          tool.length > prefix.length &&
          !mcpToolDenied(denied, server, tool),
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
