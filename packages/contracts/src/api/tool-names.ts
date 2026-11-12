import { z } from "zod";
import { MCP_SERVER_ID_PATTERN, MCP_TOOL_PREFIX } from "../kollegium/agents.ts";

export const MCP_TOOL_NAME_MAX = 128;

// The server id holds no `__`, so a name has one reading for any id that can
// exist; only the tool part is free-form. Matching is exact everywhere a name
// is compared, so `()*:` are part of a tool name here, never a pattern.
const MCP_TOOL_NAME = new RegExp(
  `^${MCP_TOOL_PREFIX}${MCP_SERVER_ID_PATTERN.slice(1, -1)}__[^\\s\\p{Cc}]+$`,
  "u",
);

/** Whether `name` is `mcp__<server>__<tool>` in the one shape every side uses. */
export function isMcpToolName(name: string): boolean {
  return name.length <= MCP_TOOL_NAME_MAX && MCP_TOOL_NAME.test(name);
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
 * settings), blocked (an engine settings deny) and compared (what a session runs).
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
