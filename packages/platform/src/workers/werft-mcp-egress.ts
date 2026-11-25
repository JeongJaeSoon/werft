import { signBuiltinMcpGrant } from "../action/index.ts";
import { WERFT_MCP_METHODS } from "../werft-mcp/index.ts";
import {
  forbidden,
  type McpEgressDecision,
  type McpEgressRequest,
} from "./mcp-egress.ts";

/**
 * Where the proxy sends the built-in `werft` server's exchanges: a path,
 * which it resolves against the authorizer it asked, a listener no worker
 * reaches.
 */
export const WERFT_MCP_UPSTREAM_PATH = "/mcp/werft";

/**
 * The `/mcp/werft` route's decision, after the token's attempt was fenced to
 * its session. It reads no release, agent or workspace: every session has
 * the server, and no setting closes it. Only the methods the server answers
 * are routed, tools, resources and prompts alike; the server reads only.
 */
export function createWerftMcpEgress(deps: {
  /** The key the authorizer signs this server's grants with. */
  grantKey: Uint8Array;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async function decide(
    fenced: { sessionId: string; attemptId: string },
    request: McpEgressRequest,
  ): Promise<McpEgressDecision> {
    const { method } = request.rpc;
    if (
      method !== null &&
      !WERFT_MCP_METHODS.includes(method) &&
      !method.startsWith("notifications/")
    ) {
      return forbidden(`JSON-RPC method ${method} is not routed`);
    }
    const bearer = signBuiltinMcpGrant(deps.grantKey, fenced, now());
    return {
      kind: "granted",
      upstream: {
        url: WERFT_MCP_UPSTREAM_PATH,
        headers: [["authorization", `Bearer ${bearer}`]],
      },
    };
  };
}
