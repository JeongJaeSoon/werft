import type {
  BudgetAccountId,
  BudgetRootKind,
  ConversationCallClass,
  ConversationCallId,
  ConversationCallKey,
  ConversationId,
  ConversationTopicId,
  ConversationTurnCallRefusal,
  ConversationTurnId,
  ConversationTurnLimit,
  ConversationTurnLimitSide,
  ConversationTurnState,
} from "@werft-ai/contracts";
import type { BudgetRoot } from "../budget-accounts.ts";
import type { ConversationCallLimit } from "../conversation-call-limits.ts";
import type { ProviderUsage } from "../model-prices.ts";
import type { BudgetAmount } from "./budget-ledger.ts";

/**
 * Provider calls that serve no session (a conversation's own calls): each
 * held on a budget account when its one-call token is issued, bound to the
 * one exchange that first uses the token, and settled by that exchange's
 * usage report. Nothing here touches a session or provider_usage.
 */
export interface ConversationCallStore {
  /**
   * Chooses the account from the root and the agent's team, reserves on it
   * and records the call, in one transaction: refused, neither exists.
   */
  issueAtomic(
    input: ConversationCallIssueInput,
  ): Promise<ConversationCallIssue>;
  /**
   * The proxy's grant question. The first one binds the token to its
   * exchange; the same exchange asks again while the token lasts.
   */
  authorizeAtomic(input: {
    tokenHash: Uint8Array;
    exchangeId: string;
  }): Promise<ConversationCallAuthorization>;
  /**
   * Writes a conversation turn `running` and its permit together: neither
   * reserves anything, each call on the permit does.
   */
  issueTurnPermitAtomic(
    input: ConversationTurnPermitInput,
  ): Promise<ConversationTurnPermitIssue>;
  /**
   * A person's mention of the agent as a conversation turn: writes the turn
   * `running` with the mention as its source, its permit, and the
   * mention's engagement pointing at it, together or not at all. A message
   * already engaged (Slack's retry of the event) adds nothing.
   */
  issueMentionTurnAtomic(
    input: ConversationMentionTurnInput,
  ): Promise<ConversationMentionTurnIssue>;
  /**
   * The proxy's grant question on a turn's permit. A new exchange is a new
   * call of the turn: counted by the call limits, reserved on the account the
   * turn's root chooses and recorded bound to that exchange, or refused with
   * nothing held and the refusal kept on the permit. The same exchange asks
   * again while its call lasts.
   */
  authorizeTurnCallAtomic(input: {
    tokenHash: Uint8Array;
    exchangeId: string;
    /** The id the call takes if this exchange is a new one. */
    callId: ConversationCallId;
    /**
     * What one call on the permit holds; null when its connection is not
     * one this API serves.
     */
    reserveFor(permit: {
      connectionId: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
    }): { reserve: BudgetAmount; unmetered: boolean } | null;
  }): Promise<ConversationTurnCallAuthorization>;
  /**
   * Ends a turn's permit, and a running turn without a decision, and
   * says what its last refused call was refused for. `limitReached` says,
   * from that refusal and whether a read tool call was refused past the
   * turn's count, which limit ended the turn, kept on its row.
   */
  endTurnAtomic(input: {
    turnId: ConversationTurnId;
    limitReached?: (
      refusal: ConversationTurnCallRefusal | null,
      toolCallRefused: boolean,
    ) => ConversationTurnLimitReached | null;
  }): Promise<{
    ended: "recorded" | "already_ended" | "gone";
    /** The turn's state after this, as recorded now or before; null when gone. */
    state: ConversationTurnState | null;
    refusal: ConversationTurnCallRefusal | null;
    limit: ConversationTurnLimitReached | null;
  }>;
  /** Ends the turn's permit no later than `until`. */
  boundTurnPermitAtomic(input: {
    turnId: ConversationTurnId;
    until: Date;
  }): Promise<void>;
  /** The bound exchange's usage report, settled on the account once. */
  settleAtomic(input: {
    callId: ConversationCallId;
    exchangeId: string;
    usage: ProviderUsage;
    priceFor(call: { unmetered: boolean }): { costUsd: number };
  }): Promise<ConversationCallSettle>;
  /**
   * Releases up to `limit` reservations whose token expired unused. A call
   * the proxy used and never reported is not released: its end is unknown.
   */
  releaseExpired(input: {
    limit: number;
    /** Counts what it would release, and writes nothing. */
    dryRun: boolean;
  }): Promise<{ released: number }>;
  /**
   * Marks up to `limit` calls in flight past the provider exchange lease
   * with no report `unknown`, the call and its reservation both: still
   * held, until a late report settles them.
   */
  markUnknown(input: {
    limit: number;
    /** Counts what it would mark, and writes nothing. */
    dryRun: boolean;
  }): Promise<{ unknown: number }>;
  /**
   * The agents holding at least `atLeast` calls of unknown end, the most
   * first, at most `limit` of them.
   */
  unknownByAgent(input: {
    atLeast: number;
    limit: number;
  }): Promise<{ workspaceId: string; agentId: string; unknown: number }[]>;
}

export type ConversationCallIssueInput = {
  callId: ConversationCallId;
  tokenHash: Uint8Array;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  /** One of the conversation's topics. */
  topicId: ConversationTopicId | null;
  callClass: ConversationCallClass;
  /** The agent's active release (an agent_releases id). */
  releaseId: string | null;
  callKey: ConversationCallKey;
  attempt: number;
  root: BudgetRoot;
  connectionId: string;
  path: string;
  model: string;
  maxTokens: number;
  maxRequestBytes: number;
  /** The most the one call may use, priced as the proxy's open prices it. */
  reserve: BudgetAmount;
  unmetered: boolean;
  ttlMs: number;
};

export type ConversationCallIssue =
  | { outcome: "issued"; expiresAt: Date }
  // The account cannot hold it, or the agent's own work has no team limit.
  | {
      outcome: "refused";
      rootKind: BudgetRootKind;
      accountId: BudgetAccountId | null;
    }
  // One of the call's keys already has its limit of calls in progress
  // (conversation-call-limits.ts); nothing is reserved.
  | {
      outcome: "concurrency_limited";
      limit: ConversationCallLimit;
      inProgress: number;
      // How many of those are of unknown end.
      unknown: number;
    }
  // No such agent in that workspace.
  | { outcome: "unknown_agent" }
  // The conversation is not the agent's, or the topic not the conversation's.
  | { outcome: "unknown_conversation" }
  // The agent already has a call of that key and attempt; none is added.
  | { outcome: "already_issued" };

export type ConversationTurnPermitInput = {
  turnId: ConversationTurnId;
  tokenHash: Uint8Array;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  /** Whom the turn serves, as its row keeps it. */
  requester: {
    kind: "user" | "slack_user" | "slack_bot" | "operator";
    id: string;
  };
  releaseId: string | null;
  root: BudgetRoot;
  connectionId: string;
  path: string;
  model: string;
  /** What each call of the turn may use. */
  maxTokens: number;
  maxRequestBytes: number;
  callKey: ConversationCallKey;
  ttlMs: number;
};

export type ConversationMentionTurnInput = Omit<
  ConversationTurnPermitInput,
  "requester" | "root"
> & {
  /** Who mentioned the agent, as the server knows them: the turn's requester and its budget root. */
  requesterUserId: string;
  slackInstallationId: string;
  /** The mention: the turn's source and the message it engages. */
  message: { teamId: string; channelId: string; ts: string };
};

export type ConversationMentionTurnIssue =
  | ConversationTurnPermitIssue
  // The message is engaged already: its turn was written before.
  | { outcome: "duplicate" }
  // The message is marked deleted.
  | { outcome: "source_deleted" };

export type ConversationTurnPermitIssue =
  | { outcome: "issued"; expiresAt: Date }
  | { outcome: "unknown_agent" }
  // The conversation is not the agent's, or the topic not the conversation's.
  | { outcome: "unknown_conversation" }
  // An admin stopped the agent in the conversation's channel.
  | { outcome: "channel_stopped" };

/** The limit that ended a turn, and who held the turn there. */
export type ConversationTurnLimitReached = {
  limit: ConversationTurnLimit;
  by: ConversationTurnLimitSide;
};

export type ConversationTurnCallAuthorization =
  | (Extract<ConversationCallAuthorization, { outcome: "ok" }> & {
      turnId: ConversationTurnId;
    })
  | {
      outcome: "refused";
      turnId: ConversationTurnId;
      rootKind: BudgetRootKind;
      accountId: BudgetAccountId | null;
    }
  | (Extract<ConversationCallIssue, { outcome: "concurrency_limited" }> & {
      turnId: ConversationTurnId;
    })
  // The turn had made as many calls as a turn may.
  | { outcome: "turn_limited"; turnId: ConversationTurnId }
  // The permit's connection is gone from this API's catalog.
  | { outcome: "unavailable" }
  // Unknown, expired, its turn ended, or the exchange is another call's.
  | { outcome: "invalid_token" };

export type ConversationCallAuthorization =
  | {
      outcome: "ok";
      callId: ConversationCallId;
      connectionId: string;
      path: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
    }
  // Unknown, expired, settled, released, or bound to another exchange.
  | { outcome: "invalid_token" };

export type ConversationCallSettle =
  | {
      outcome: "settled" | "already_settled";
      costUsd: number;
      // The reservation was on an unmetered connection, so nothing was priced.
      unmetered: boolean;
    }
  | { outcome: "unknown_call" }
  // Another exchange's call, or the same exchange reported other usage.
  | { outcome: "conflict" };
