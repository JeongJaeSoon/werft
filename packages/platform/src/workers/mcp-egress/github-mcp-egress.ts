import { GITHUB_MCP_FIXED_TOOLS, githubMcpTools } from "@werft-ai/contracts";
import { signBuiltinMcpGrant } from "../../action/index.ts";
import type { GitHubMcpStore } from "../../github/ports/github-mcp.ts";
import {
  forbidden,
  type McpEgressDecision,
  type McpEgressRequest,
  mcpMethodRouted,
} from "./mcp-egress.ts";

/**
 * Where the proxy sends the built-in server's exchanges: a path, which it
 * resolves against the authorizer it asked, a listener no worker reaches.
 */
export const GITHUB_MCP_UPSTREAM_PATH = "/mcp/github";

/**
 * The `/mcp/github` route's decision, after the token's attempt was fenced to its session: the
 * release carries GitHub settings, the agent's switch is on, the session
 * names who started it, and a tool call names a tool the release exposes.
 * No receipt: a call the gate refuses leaves the gate's own.
 */
export function createGitHubMcpEgress(deps: {
  store: Pick<GitHubMcpStore, "sessionState">;
  /** The key the authorizer signs grants with. */
  grantKey: Uint8Array;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async function decide(
    fenced: { sessionId: string; attemptId: string },
    request: McpEgressRequest,
  ): Promise<McpEgressDecision> {
    const state = await deps.store.sessionState(fenced.sessionId);
    if (state === null || state.github === null) {
      return forbidden("The session's release carries no GitHub settings");
    }
    // Under the agent's settings the server refuses each call: a session's
    // tools stay as they were when it started.
    if (!state.enabled && state.source === "release") {
      return forbidden("GitHub is turned off for this agent");
    }
    if (state.actor === null) {
      return forbidden("The session names no one who started it");
    }
    const { method, tool } = request.rpc;
    if (method !== null && !mcpMethodRouted(method)) {
      return forbidden(`JSON-RPC method ${method} is not routed`);
    }
    const exposed: readonly string[] =
      state.source === "release"
        ? githubMcpTools(state.github)
        : GITHUB_MCP_FIXED_TOOLS;
    if (method === "tools/call" && (tool === null || !exposed.includes(tool))) {
      return forbidden("The release does not expose this GitHub tool");
    }
    const bearer = signBuiltinMcpGrant(deps.grantKey, fenced, now());
    return {
      kind: "granted",
      upstream: {
        url: GITHUB_MCP_UPSTREAM_PATH,
        headers: [["authorization", `Bearer ${bearer}`]],
      },
    };
  };
}
