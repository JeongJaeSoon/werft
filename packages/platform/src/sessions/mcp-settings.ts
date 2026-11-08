import { MCP_TOOL_PREFIX, mcpStartSchema } from "@werft-ai/contracts";

/** The agent's saved MCP settings, as the readers need them. */
export type AgentMcpSettingsView = {
  server: string | null;
  allowedTools: readonly string[];
  /** Null on a row copied from a release; only a person's save sets it. */
  updatedBy: string | null;
};

/** What a session's release says about MCP, read off its card and pins. */
export type ReleaseMcpView = {
  server: string | null;
  /** The release's `allow` pins for `server`. */
  tools: readonly string[];
  /** `runtime_config_snapshot.mcp_deny`: names no session of the release may call. */
  deny: readonly string[];
};

export type EffectiveMcp = { server: string | null; tools: string[] };

/** The `mcp_deny` a release snapshot carries; anything else reads as none. */
export function mcpDenyOf(snapshot: unknown): string[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const deny = (snapshot as { mcp_deny?: unknown }).mcp_deny;
  return Array.isArray(deny)
    ? deny.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The MCP server and tools one session may use now.
 *
 * A session that started with a snapshot (`start`) follows the agent's
 * settings: its server is fixed, and its tools are what the snapshot and the
 * row both allow, so a change narrows it at once and widens only the next
 * session. A row that is gone or names another server closes it.
 *
 * A session without one follows its release. A row a person saved still
 * narrows it the same way (design 3.7); a row copied from a release does not,
 * since it says what the release already does.
 */
export function effectiveMcp(input: {
  start: unknown;
  row: AgentMcpSettingsView | null;
  release: ReleaseMcpView;
}): EffectiveMcp {
  const denied = new Set(input.release.deny);
  const within = (server: string, tools: readonly string[]): string[] => {
    const prefix = `${MCP_TOOL_PREFIX}${server}__`;
    return tools
      .filter(
        (tool) =>
          tool.startsWith(prefix) &&
          tool.length > prefix.length &&
          !denied.has(tool),
      )
      .sort();
  };

  if (input.start !== null && input.start !== undefined) {
    const start = mcpStartSchema.safeParse(input.start);
    if (!start.success) return { server: null, tools: [] };
    const { server } = start.data;
    if (server === null) return { server: null, tools: [] };
    if (input.row === null || input.row.server !== server) {
      return { server, tools: [] };
    }
    const now = new Set(input.row.allowedTools);
    return {
      server,
      tools: within(
        server,
        start.data.allowed_tools.filter((tool) => now.has(tool)),
      ),
    };
  }

  const { server } = input.release;
  if (server === null) return { server: null, tools: [] };
  if (input.row === null || input.row.updatedBy === null) {
    return { server, tools: within(server, input.release.tools) };
  }
  if (input.row.server !== server) return { server, tools: [] };
  const now = new Set(input.row.allowedTools);
  return {
    server,
    tools: within(
      server,
      input.release.tools.filter((tool) => now.has(tool)),
    ),
  };
}
