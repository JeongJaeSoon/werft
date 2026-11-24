import type {
  BudgetAccountId,
  BudgetRootKind,
  ConversationCallClass,
  ConversationCallId,
  ConversationCallKey,
  ConversationId,
  ConversationTopicId,
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
