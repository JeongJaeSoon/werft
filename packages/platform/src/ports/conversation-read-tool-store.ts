import type {
  ConversationId,
  ConversationReadTool,
  ConversationRuntimeId,
  ConversationTopicId,
  ConversationTurnDecision,
  ConversationTurnId,
  ConversationTurnLeaseId,
} from "@werft-ai/contracts";
import type { SourceKey, SourcePlace } from "../conversations/index.ts";
import type { SessionViewer } from "../sessions/ports/session-share-store.ts";

/** Where a turn's conversation is, as its read tools see it. */
export type ConversationToolPlace =
  | {
      kind: "channel";
      teamId: string;
      channelId: string;
      /** Not known to be public: a kind no binding names is held private. */
      private: boolean;
    }
  | { kind: "dm"; personUserId: string };

/** The turn a read tool call is for, as the server holds it, never as asked. */
export type ConversationToolTurn = {
  turnId: ConversationTurnId;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  /** The turn's requester, the server's value (turn-requester kinds). */
  requester: { kind: string; id: string };
  slackInstallationId: string | null;
  place: ConversationToolPlace;
  /** The topic's Slack thread; null for a web topic Slack has not placed. */
  thread: SourcePlace | null;
};

export type ConversationToolAdmission =
  | { outcome: "admitted"; turn: ConversationToolTurn }
  | { outcome: "unknown_turn" }
  // Another lease holds the turn, or it is not leased now.
  | { outcome: "not_holder" }
  | { outcome: "lease_expired" }
  // Counted all the same: the turn ends on the server's limit.
  | { outcome: "tool_call_limit" }
  | { outcome: "thread_read_limit" };

/** An ended turn of the conversation, as read_turns lists it. */
export type ConversationTurnRecord = {
  turnId: ConversationTurnId;
  topicId: ConversationTopicId | null;
  endedAt: Date;
  decision: ConversationTurnDecision | null;
  reason: string | null;
  /** The agent's answer, read again where its pointer points; null for none. */
  answer: string | null;
  /** What the turn came from, direct and inherited. */
  sources: SourceKey[];
};

/** A task of the conversation that has not ended. */
export type ConversationOpenTask = {
  sessionId: string;
  /** Null when it has none, or its title came from a deleted message. */
  title: string | null;
  status: string;
  createdAt: Date;
};

/**
 * The server's side of a conversation turn's read tools: the turn a call is
 * for, its counts, and what the tools read of the database.
 */
export interface ConversationReadToolStore {
  /**
   * The turn, when `runtimeId` holds it under `leaseId` and the lease is
   * not over; counts the call, and a thread read, on the turn's permit.
   */
  admit(input: {
    turnId: ConversationTurnId;
    leaseId: ConversationTurnLeaseId;
    runtimeId: ConversationRuntimeId;
    tool: ConversationReadTool;
    now: Date;
  }): Promise<ConversationToolAdmission>;
  /** Slack answered 429: the turn reads no thread again. */
  closeThreadReads(turnId: ConversationTurnId): Promise<void>;
  /** Adds what a tool read to the turn's direct sources (decision 37). */
  addDirectSources(
    turnId: ConversationTurnId,
    keys: readonly SourceKey[],
  ): Promise<void>;
  /** The places among `places` Slack or an admin deleted. */
  deletedAmong(
    workspaceId: string,
    places: readonly SourcePlace[],
  ): Promise<SourcePlace[]>;
  /**
   * The conversation's ended turns, newest first. A turn a deleted message
   * went into, or whose sources overflowed, is left out.
   */
  endedTurns(input: {
    turn: ConversationToolTurn;
    limit: number;
  }): Promise<ConversationTurnRecord[]>;
  /**
   * The conversation's tasks that have not ended, newest first, that
   * `viewer` sees; with no viewer, only those shared with the workspace or
   * behind the conversation's own private channel.
   */
  openTasks(input: {
    turn: ConversationToolTurn;
    viewer: SessionViewer | null;
    limit: number;
  }): Promise<ConversationOpenTask[]>;
}

/** One message of a thread, its author judged where it may be heard. */
export type ConversationThreadMessage = {
  ts: string;
  author: { kind: "person"; slackUserId: string } | { kind: "bot" };
  text: string;
};

export type ConversationThreadRead =
  | {
      outcome: "read";
      messages: ConversationThreadMessage[];
      /** Left out: a guest's, a stranger's, or one whose author was not confirmed. */
      withheld: number;
    }
  | { outcome: "external_shared" }
  | { outcome: "rate_limited" }
  | { outcome: "unavailable" };

/** Reads one Slack thread with the agent's bot token. */
export interface ConversationThreadReader {
  read(input: {
    workspaceId: string;
    agentId: string;
    thread: SourcePlace;
    limit: number;
  }): Promise<ConversationThreadRead>;
}
