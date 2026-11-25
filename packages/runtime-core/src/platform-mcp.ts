import { WERFT_MCP_SERVER } from "@werft-ai/contracts";
import type { PlatformMcpServer } from "./agent-runtime.ts";

function own(server: PlatformMcpServer, names: readonly string[]): string[] {
  const prefix = `mcp__${server.name}__`;
  return names.filter((name) => name.startsWith(prefix));
}

/**
 * The tools of the built-in `werft` server, as `mcp__werft__<tool>`: the
 * ones its claim entry trusts. The server decides what it serves, so no
 * release pins these names, they are in no allowlist and no checkpoint
 * fingerprint holds them. They read only, and a run calls them unasked.
 * Empty for any other server, whose trusted tools stay inside its allowlist.
 */
export function servedMcpTools(server: PlatformMcpServer): string[] {
  return server.platform === true && server.name === WERFT_MCP_SERVER
    ? own(server, server.trusted ?? [])
    : [];
}

/**
 * The tools of `server` a run shows its engine, as `mcp__<server>__<tool>`:
 * its share of the allowlist, and for the built-in `werft` server the tools
 * it serves.
 */
export function exposedMcpTools(server: PlatformMcpServer): string[] {
  return [
    ...new Set([...own(server, server.tools), ...servedMcpTools(server)]),
  ];
}
