import type { ReceiptActor, ReceiptStatus } from "@werft-ai/contracts";

/**
 * Why a remote MCP exchange was refused for the agent's credential. Every
 * one is a CREDENTIAL_UNBOUND receipt; the reason tells them apart.
 */
export type McpRefusalReason =
  | "credential_unbound"
  | "workspace_not_allowed"
  | "catalog_moved";

/** What the MCP route is judged on, read fresh for every exchange. */
export type McpSessionState = {
  ownerId: string;
  /** Null for a session made before workspaces. */
  workspaceSlug: string | null;
  agentId: string;
  releaseId: string;
  /** The server the session may reach now (`effectiveMcp`). */
  server: string | null;
  /** The `mcp__<server>__<tool>` names it may call now. */
  tools: readonly string[];
  /** The credential names bound to the agent now, revoked ones left out. */
  boundRefs: readonly string[];
  /** The turn the attempt is running, by its public id; null between turns. */
  turnId: string | null;
  /** Who started the session, as its receipts name them, with the agent. */
  actor: ReceiptActor | null;
};

export type McpRefusalRecord = {
  id: string;
  ownerId: string;
  sessionId: string;
  turnId: string | null;
  /** `unknown` when an exchange already under way was cut. */
  status: Extract<ReceiptStatus, "failed" | "unknown">;
  actor: ReceiptActor | null;
  result: {
    attempt_id: string;
    agent_id: string;
    release_id: string;
    server_id: string;
    reason: McpRefusalReason;
  };
  message: string;
};

/** The reads behind a session's MCP grant, and its refusal receipts. */
export interface McpEgressStore {
  /** Null when the session pins no agent release. */
  sessionState(input: {
    sessionId: string;
    attemptId: string;
  }): Promise<McpSessionState | null>;
  /**
   * In its own transaction, after the refusal was decided: a receipt that
   * cannot be written must not turn the refusal into an outage. The same
   * id twice is one receipt.
   */
  recordRefusal(record: McpRefusalRecord): Promise<void>;
}
