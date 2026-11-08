import { createHash } from "node:crypto";
import { MCP_TOOL_PREFIX } from "@werft-ai/contracts";
import type { McpEgressStore, McpRefusalReason } from "../ports/mcp-egress.ts";
import {
  type EgressUpstream,
  mcpBinding,
  mcpUpstreamOf,
  type SessionCatalog,
} from "../sessions/catalog.ts";

/**
 * The remote MCP route's decision, made on every exchange the egress proxy
 * relays: the token's attempt still owns its session (the caller has
 * checked), the server is the one its release names, as the catalog had it
 * at the claim, the agent's credential for it is still bound, the session's
 * workspace is one the operator allows it in, and the JSON-RPC call is one
 * the release pins. A refusal for the catalog, the credential or the
 * workspace is about the agent's credential and leaves a receipt.
 */

export type McpEgressRequest = {
  /** The `<name>` of the proxy's `/mcp/<name>` route. */
  server: string;
  /** The JSON-RPC request, as the proxy read it; null fields for a GET or DELETE. */
  rpc: { method: string | null; tool: string | null };
  /** An exchange already under way asking again. */
  regrant: boolean;
};

export type McpEgressDecision =
  | { kind: "granted"; upstream: EgressUpstream }
  | {
      kind: "refused";
      status: 403;
      code: "CREDENTIAL_UNBOUND" | "FORBIDDEN";
      message: string;
      receiptId?: string;
    };

// The JSON-RPC methods a tool call takes. Resources, prompts, completions
// and the rest would reach the service account's data past the tool pins.
export const ALLOWED_MCP_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
]);

const REFUSAL_MESSAGES: Record<McpRefusalReason, string> = {
  credential_unbound:
    "The agent's credential for this MCP server is no longer bound to it",
  workspace_not_allowed:
    "The catalog does not allow this MCP server in the session's workspace",
  catalog_moved:
    "The MCP server changed in the catalog since this attempt was claimed",
};

// A fixed namespace for receipt ids, so the same refusal names one receipt.
const RECEIPT_NAMESPACE = Buffer.from(
  "6d3f1c52b0e74c0b9a4e2f7d81c05a39",
  "hex",
);

/** RFC 9562 version 5: SHA-1 of the namespace and the name. */
export function uuidV5(name: string): string {
  const bytes = createHash("sha1")
    .update(RECEIPT_NAMESPACE)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function forbidden(message: string): McpEgressDecision {
  return { kind: "refused", status: 403, code: "FORBIDDEN", message };
}

export function createMcpEgress(deps: {
  catalog: SessionCatalog;
  store: McpEgressStore;
  /** Told when a refusal's receipt could not be written. */
  onReceiptError?: (error: unknown) => void;
}) {
  const { catalog, store } = deps;
  return async function decide(
    fenced: { sessionId: string; attemptId: string; binding: string },
    request: McpEgressRequest,
  ): Promise<McpEgressDecision> {
    const state = await store.sessionState(fenced);
    if (state === null || state.server === null) {
      return forbidden("The session's release names no MCP server");
    }
    if (request.server !== state.server) {
      return forbidden("The egress token is for another MCP server");
    }
    const server = Object.hasOwn(catalog.mcp_servers ?? {}, state.server)
      ? catalog.mcp_servers?.[state.server]
      : undefined;
    const reason: McpRefusalReason | null =
      server === undefined ||
      mcpBinding(state.releaseId, state.server, server) !== fenced.binding
        ? "catalog_moved"
        : !state.boundRefs.includes(server.credential_ref)
          ? "credential_unbound"
          : state.workspaceSlug === null ||
              !server.workspaces.includes(state.workspaceSlug)
            ? "workspace_not_allowed"
            : null;
    if (reason !== null || server === undefined) {
      const why = reason ?? "catalog_moved";
      const status = request.regrant ? "unknown" : "failed";
      const receiptId = uuidV5(
        JSON.stringify([
          fenced.attemptId,
          state.server,
          why,
          state.turnId,
          status,
        ]),
      );
      let recorded = true;
      try {
        await store.recordRefusal({
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
            server_id: state.server,
            reason: why,
          },
          message: REFUSAL_MESSAGES[why],
        });
      } catch (error) {
        recorded = false;
        deps.onReceiptError?.(error);
      }
      return {
        kind: "refused",
        status: 403,
        code: "CREDENTIAL_UNBOUND",
        message: REFUSAL_MESSAGES[why],
        ...(recorded ? { receiptId } : {}),
      };
    }
    const { method, tool } = request.rpc;
    if (
      method !== null &&
      !ALLOWED_MCP_METHODS.has(method) &&
      !method.startsWith("notifications/")
    ) {
      return forbidden(`JSON-RPC method ${method} is not routed`);
    }
    if (method === "tools/call") {
      const named =
        tool === null ? null : `${MCP_TOOL_PREFIX}${state.server}__${tool}`;
      if (named === null || !state.tools.includes(named)) {
        return forbidden("The release does not allow this MCP tool");
      }
    }
    return { kind: "granted", upstream: mcpUpstreamOf(server) };
  };
}
