import { MCP_TOOL_PREFIX } from "@werft-ai/contracts";
import { pinnedMcpTools } from "../sessions/catalog.ts";

/**
 * What a release says about MCP, as an agent's settings would hold it: the
 * card's server and credential names, and the `allow` pins for that server.
 * Counts cover what a settings row cannot carry, so a copy shows what it
 * leaves behind.
 */
export type McpReleaseValues = {
  server: string | null;
  allowedTools: string[];
  credentialRefs: string[];
  /** `ask` pins for the server's tools; not carried by a row. */
  askCount: number;
  /** `deny` pins for the server's tools; not carried by a row. */
  denyCount: number;
  /** The card's `forbidden` MCP names; not carried by a row. */
  forbiddenCount: number;
};

const NONE: McpReleaseValues = {
  server: null,
  allowedTools: [],
  credentialRefs: [],
  askCount: 0,
  denyCount: 0,
  forbiddenCount: 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Read off a stored card and pins without the full schemas: a release is
 * immutable and was parsed whole when it was made. Names come out sorted and
 * once each, the way a settings row stores them.
 */
export function mcpValuesOfCard(
  card: unknown,
  policyPins: unknown,
): McpReleaseValues {
  if (!isRecord(card) || !isRecord(card.capabilities)) return NONE;
  const capabilities = card.capabilities;
  const named = Array.isArray(capabilities.mcp) ? capabilities.mcp[0] : null;
  const server =
    isRecord(named) && typeof named.server === "string" ? named.server : null;
  const credentialRefs = [
    ...new Set(strings(capabilities.credential_refs)),
  ].sort();
  const forbidden = strings(capabilities.forbidden).filter((name) =>
    name.startsWith(MCP_TOOL_PREFIX),
  );
  if (server === null) {
    return { ...NONE, credentialRefs, forbiddenCount: forbidden.length };
  }
  const tools = isRecord(policyPins) ? policyPins.tools : null;
  const perTool: Record<string, string> =
    isRecord(tools) && isRecord(tools.per_tool)
      ? Object.fromEntries(
          Object.entries(tools.per_tool).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const prefix = `${MCP_TOOL_PREFIX}${server}__`;
  const policies = Object.entries(perTool).filter(
    ([name]) => name.startsWith(prefix) && name.length > prefix.length,
  );
  const count = (policy: string) =>
    policies.filter(([, value]) => value === policy).length;
  return {
    server,
    allowedTools: pinnedMcpTools(server, perTool),
    credentialRefs,
    askCount: count("ask"),
    denyCount: count("deny"),
    forbiddenCount: forbidden.length,
  };
}
