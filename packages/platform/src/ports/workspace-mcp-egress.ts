import type { ReceiptActor, ReceiptStatus } from "@werft-ai/contracts";

/**
 * Why a workspace MCP server's exchange was refused. Every one is a
 * CREDENTIAL_UNBOUND `call_mcp` receipt; the reason tells them apart.
 */
export type WorkspaceMcpRefusalReason =
  // The server is gone from the workspace, renamed or moved to another URL
  // since the session started, or the agent turned it off.
  | "workspace_server_unavailable"
  // An admin has to connect the server again.
  | "oauth_needs_reauth"
  // The server holds no credential to send, or it could not be refreshed.
  | "credential_unavailable";

/** What a workspace server's route is judged on, read fresh per exchange. */
export type WorkspaceMcpSessionState = {
  ownerId: string;
  workspaceId: string;
  agentId: string;
  releaseId: string;
  /** The snapshot's server by the route's name. */
  serverId: string;
  /**
   * The row with the snapshot's id is in the session's workspace under the
   * snapshot's name and URL, and the agent has it on.
   */
  available: boolean;
  /** The row's URL; null when the row is gone. */
  url: string | null;
  /** Null when the row is gone. */
  connection: {
    state: "none" | "active" | "needs_reauth";
    generation: number;
  } | null;
  /**
   * The `mcp__<name>__<tool>` names it may call now: the snapshot's, still
   * stored, less every deny source as the rows are now.
   */
  tools: readonly string[];
  /** The turn the attempt is running, by its public id; null between turns. */
  turnId: string | null;
  actor: ReceiptActor | null;
};

export type WorkspaceMcpRefusalRecord = {
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
    workspace_server_id: string;
    /** The connection's generation when refused; null when the row is gone. */
    connection_generation: number | null;
    reason: WorkspaceMcpRefusalReason;
  };
  message: string;
};

/**
 * A tool call forwarded to a workspace server, under the connection whose
 * credential it carries. Whether the server ran it is not seen.
 */
export type WorkspaceMcpCallRecord = {
  id: string;
  ownerId: string;
  sessionId: string;
  turnId: string | null;
  actor: ReceiptActor | null;
  result: {
    attempt_id: string;
    agent_id: string;
    release_id: string;
    server_id: string;
    workspace_server_id: string;
    connection_generation: number;
    tool: string;
  };
};

/** The reads behind a workspace server's grant, and its receipts. */
export interface WorkspaceMcpEgressStore {
  /**
   * Null when the session's snapshot names no workspace server called
   * `server`: the route is not a workspace server's.
   */
  sessionState(input: {
    sessionId: string;
    attemptId: string;
    server: string;
  }): Promise<WorkspaceMcpSessionState | null>;
  /** In its own transaction; the same id twice is one receipt. */
  recordRefusal(record: WorkspaceMcpRefusalRecord): Promise<void>;
  /**
   * An `accepted` receipt for a tool call sent upstream, written only while
   * the connection is still active at the generation named; false, with
   * nothing written, when it moved.
   */
  recordCall(record: WorkspaceMcpCallRecord): Promise<boolean>;
}
