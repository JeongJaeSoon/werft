import { randomUUID } from "node:crypto";
import { mcpToolPermitted } from "../catalog/index.ts";
import {
  forbidden,
  type McpEgressDecision,
  type McpEgressRequest,
  mcpMethodRouted,
  recordAndRefuse,
  uuidV5,
} from "./mcp-egress.ts";
import type {
  WorkspaceMcpEgressStore,
  WorkspaceMcpRefusalReason,
} from "./ports/workspace-mcp-egress.ts";

/**
 * A workspace remote MCP server's route,
 * decided on every exchange from the rows as they are: the server the
 * session started with is still in its workspace and on for the agent, its
 * connection is active, the JSON-RPC method is a tool call's, and a called
 * tool is in the stored list less every deny. The token's binding is not
 * compared: one token serves every server of the attempt.
 */

/** What control-host sends a server's calls with (`credentialFor`). */
export type WorkspaceMcpCallCredential =
  | { kind: "bearer"; token: string }
  | { kind: "oauth"; accessToken: string };

const REFUSAL_MESSAGES: Record<WorkspaceMcpRefusalReason, string> = {
  workspace_server_unavailable:
    "The workspace MCP server is gone, moved, or no longer on for this agent",
  oauth_needs_reauth:
    "The workspace MCP server has to be connected again by a workspace admin",
  credential_unavailable:
    "The workspace MCP server has no credential to call it with",
  egress_proxy_outdated:
    "The egress proxy is older than the API and cannot reach this server; upgrade the proxy",
};

export function createWorkspaceMcpEgress(deps: {
  store: WorkspaceMcpEgressStore;
  /** Refreshed first when near expiry; null when there is none to use. */
  credentialFor: (
    workspaceId: string,
    serverId: string,
  ) => Promise<WorkspaceMcpCallCredential | null>;
  /**
   * Where the operator's credential allowlists put a server URL's host:port:
   * `private` only on the private one, `public` on the other, null on
   * neither. A private one is left to the proxy's lists; absent, on neither.
   */
  operatorListed?: (url: string) => "public" | "private" | null;
  onReceiptError?: (error: unknown) => void;
}) {
  const { store } = deps;
  /** Null when the route is not one of the session's workspace servers. */
  return async function decide(
    fenced: { sessionId: string; attemptId: string },
    request: McpEgressRequest,
  ): Promise<McpEgressDecision | null> {
    const state = await store.sessionState({
      sessionId: fenced.sessionId,
      attemptId: fenced.attemptId,
      server: request.server,
    });
    if (state === null) return null;

    const refuse = async (
      why: WorkspaceMcpRefusalReason,
    ): Promise<McpEgressDecision> => {
      const status = request.regrant ? "unknown" : "failed";
      const generation = state.connection?.generation ?? null;
      const receiptId = uuidV5(
        JSON.stringify([
          fenced.attemptId,
          request.server,
          state.serverId,
          generation,
          why,
          state.turnId,
          status,
        ]),
      );
      return recordAndRefuse(
        store,
        {
          id: receiptId,
          ownerId: state.ownerId,
          sessionId: fenced.sessionId,
          turnId: state.turnId,
          status,
          actor: state.actor,
          result: {
            attempt_id: fenced.attemptId,
            agent_id: state.agentId,
            release_id: state.releaseId,
            server_id: request.server,
            workspace_server_id: state.serverId,
            connection_generation: generation,
            reason: why,
          },
          message: REFUSAL_MESSAGES[why],
        },
        deps,
      );
    };

    if (!state.available || state.url === null || state.connection === null) {
      return refuse("workspace_server_unavailable");
    }
    if (state.connection.state === "needs_reauth") {
      return refuse("oauth_needs_reauth");
    }
    if (state.connection.state !== "active") {
      return refuse("credential_unavailable");
    }
    const { method, tool } = request.rpc;
    if (method !== null && !mcpMethodRouted(method)) {
      return forbidden(`JSON-RPC method ${method} is not routed`);
    }
    if (method === "tools/call") {
      if (
        tool === null ||
        !mcpToolPermitted(state.tools, request.server, tool)
      ) {
        return forbidden("The workspace does not allow this MCP tool");
      }
    }
    const at = new URL(state.url);
    const listed = deps.operatorListed?.(state.url) ?? null;
    // A proxy from before the mark holds the upstream to its own lists,
    // which do not name this host: refused here instead, with a reason the
    // operator reads in the receipt.
    if (listed === null && request.registeredUpstream !== true) {
      return refuse("egress_proxy_outdated");
    }
    const credential = await deps.credentialFor(
      state.workspaceId,
      state.serverId,
    );
    if (credential === null) return refuse("credential_unavailable");
    const token =
      credential.kind === "bearer" ? credential.token : credential.accessToken;
    if (method === "tools/call" && tool !== null && !request.regrant) {
      const recorded = await store.recordCall({
        id: randomUUID(),
        ownerId: state.ownerId,
        sessionId: fenced.sessionId,
        turnId: state.turnId,
        actor: state.actor,
        result: {
          attempt_id: fenced.attemptId,
          agent_id: state.agentId,
          release_id: state.releaseId,
          server_id: request.server,
          workspace_server_id: state.serverId,
          connection_generation: state.connection.generation,
          tool,
        },
      });
      // Reconnected since the state was read: the credential may be the
      // new connection's, which the receipt would not name.
      if (!recorded) return refuse("credential_unavailable");
    }
    return {
      kind: "granted",
      upstream: {
        url: `${at.origin}${at.pathname}`,
        // As registered: the proxy would trim a trailing slash from `url`
        // and refuses a query in it.
        target: `${at.pathname}${at.search}`,
        headers: [["authorization", `Bearer ${token}`]],
        // The operator's private host stays under the proxy's lists.
        ...(listed !== "private" && at.protocol === "https:"
          ? { allow: "public_https" as const }
          : {}),
      },
    };
  };
}
