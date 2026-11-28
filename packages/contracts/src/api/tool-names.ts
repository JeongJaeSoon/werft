import { z } from "zod";
import { MCP_SERVER_ID_PATTERN, MCP_TOOL_PREFIX } from "../agents/agents.ts";

export const MCP_TOOL_NAME_MAX = 128;

// The server id holds no `__`, so a name has one reading for any id that can
// exist; only the tool part is free-form. Matching is exact everywhere a name
// is compared, so `()*:` are part of a tool name here, never a pattern. The
// one exception is a name ending in `__*`, which is the deny rule for a whole
// server and never a tool.
const MCP_TOOL_NAME = new RegExp(
  `^${MCP_TOOL_PREFIX}${MCP_SERVER_ID_PATTERN.slice(1, -1)}__[^\\s\\p{Cc}]+$`,
  "u",
);
const MCP_SERVER_ID = new RegExp(MCP_SERVER_ID_PATTERN);
const MCP_SERVER_WILDCARD_SUFFIX = "__*";

/** Whether `name` is `mcp__<server>__<tool>` in the one shape every side uses. */
export function isMcpToolName(name: string): boolean {
  return (
    name.length <= MCP_TOOL_NAME_MAX &&
    !name.endsWith(MCP_SERVER_WILDCARD_SUFFIX) &&
    MCP_TOOL_NAME.test(name)
  );
}

/** The deny rule `mcp__<server>__*`, which names every tool of `server`. */
export function mcpServerWildcard(server: string): string {
  return `${MCP_TOOL_PREFIX}${server}${MCP_SERVER_WILDCARD_SUFFIX}`;
}

/** Whether `rule` is `mcp__<server>__*` for a server id that can exist. */
export function isMcpServerWildcard(rule: string): boolean {
  return (
    rule.startsWith(MCP_TOOL_PREFIX) &&
    rule.endsWith(MCP_SERVER_WILDCARD_SUFFIX) &&
    MCP_SERVER_ID.test(
      rule.slice(MCP_TOOL_PREFIX.length, -MCP_SERVER_WILDCARD_SUFFIX.length),
    )
  );
}

/**
 * Whether `name` is a tool of `server`. An id may end in `_`, so the same
 * name can read as the tool `_read` of `docs` and `read` of `docs_`: the
 * server is asked about, never split out of the name.
 */
export function mcpToolOfServer(name: string, server: string): boolean {
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  // Past the prefix there must be a tool of its own: `mcp__docs___` is the
  // tool `_` of `docs`, and nothing of `docs_`.
  return (
    name.startsWith(prefix) &&
    name.length > prefix.length &&
    isMcpToolName(name)
  );
}

/**
 * The one rule for an `mcp__` tool name that is allowed (an agent's MCP
 * settings), blocked (a release deny) and compared (what a session runs).
 */
export const mcpToolNameSchema = z
  .string()
  .refine(isMcpToolName, `must be an ${MCP_TOOL_PREFIX}<server>__<tool> name`);

export type ToolBoundaryValue = "local" | "egress" | "provider";

/**
 * A built-in tool catalog as a rule reads it: the runtime's (with
 * `aliases`) or a response's (without).
 */
export type ToolCatalogView = {
  readonly id: string;
  readonly tools: readonly {
    readonly name: string;
    readonly boundary: ToolBoundaryValue;
  }[];
  /** Older names the engine still takes, keyed to the name it reports now. */
  readonly aliases?: Readonly<Record<string, string>> | undefined;
};
