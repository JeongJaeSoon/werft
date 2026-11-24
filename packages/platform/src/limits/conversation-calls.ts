import { randomBytes } from "node:crypto";
import {
  type AgentRelease,
  type ConversationCallClass,
  type ConversationCallId,
  type ConversationCallKey,
  type ConversationId,
  type ConversationTopicId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  releaseJudgmentModel,
} from "@werft-ai/contracts";
import {
  connectionModels,
  connectionOf,
  type SessionCatalog,
} from "../catalog/index.ts";
import { hashToken } from "../token-hash.ts";
import type { BudgetRoot } from "./budget-accounts.ts";
import type { ProviderUsage } from "./model-prices.ts";
import type {
  ConversationCallIssue,
  ConversationCallStore,
} from "./ports/conversation-call-store.ts";
import { reservationCostUsd, reservationTokens } from "./reservations.ts";

export const CONVERSATION_CALL_TOKEN_PREFIX = "wec_";
// One call's life: issued, used and answered. A token not used by then is
// released by the reconciler; one in use is cut by the proxy's regrant.
export const CONVERSATION_CALL_TOKEN_TTL_MS = 2 * 60_000;
// The one route a conversation call takes.
export const CONVERSATION_CALL_PATH = "/v1/messages";

// An operator's own call is charged as an operator key's and keyed under
// this prefix, which is how its ledger row is told from every other call's:
// the ledger has no column for a key's kind.
export const OPERATOR_CALL_KEY_PREFIX = "operator-";
const OPERATOR_ROOT: BudgetRoot = {
  kind: "key",
  keyKind: "operator",
  createdByUserId: null,
};

export const hashConversationCallToken = hashToken;

/**
 * What a conversation call may use at most: its request's bytes read as
 * input tokens, as the proxy's open estimates them, and its output cap.
 * Unknown speed and region price as the dearest.
 */
export function conversationCallReserve(call: {
  model: string;
  maxTokens: number;
  maxRequestBytes: number;
}): { costUsd: number; tokens: number } {
  const usage: ProviderUsage = {
    model: call.model,
    inputTokens: call.maxRequestBytes,
    outputTokens: call.maxTokens,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    speed: "unknown",
    inferenceGeo: "unknown",
    webSearchRequests: 0,
    webFetchRequests: 0,
    codeExecutionRequests: 0,
    estimated: true,
  };
  return {
    costUsd: reservationCostUsd(usage),
    tokens: reservationTokens(usage),
  };
}

export type ConversationCallIssued =
  | {
      outcome: "issued";
      callId: ConversationCallId;
      /** Sent as the call's API key to the proxy's provider route. */
      token: string;
      expiresAt: Date;
    }
  | Exclude<ConversationCallIssue, { outcome: "issued" }>
  | { outcome: "unavailable"; reason: ConversationCallUnavailable };

/**
 * Why a call cannot go out: the connection is not one the catalog holds
 * (disabled or removed) or serves no Messages, or the model is off its list.
 * No successor stands in for a removed model, as one does for a session's.
 */
export type ConversationCallUnavailable =
  | "connection_missing"
  | "model_removed";

function callConnection(
  catalog: Pick<SessionCatalog, "connections">,
  connectionId: string,
  model: string | undefined,
):
  | { connection: SessionCatalog["connections"][string] }
  | { reason: ConversationCallUnavailable } {
  const connection = connectionOf(catalog, connectionId);
  if (!connection || connection.provider.kind === "openai_responses") {
    return { reason: "connection_missing" };
  }
  return model !== undefined && connectionModels(connection).includes(model)
    ? { connection }
    : { reason: "model_removed" };
}

/**
 * What an agent's judgment calls go through: its active release's connection
 * and judgment model (the card's model when it names none), or why they
 * cannot run.
 */
export function judgmentCallOf(
  catalog: Pick<SessionCatalog, "connections">,
  release: Pick<
    AgentRelease,
    "id" | "connection_id" | "runtime_config_snapshot"
  >,
):
  | { outcome: "ready"; releaseId: string; connectionId: string; model: string }
  | { outcome: "unavailable"; reason: ConversationCallUnavailable } {
  const model = releaseJudgmentModel(release);
  const found = callConnection(catalog, release.connection_id, model);
  if ("reason" in found || model === undefined) {
    return {
      outcome: "unavailable",
      reason: "reason" in found ? found.reason : "model_removed",
    };
  }
  return {
    outcome: "ready",
    releaseId: release.id,
    connectionId: release.connection_id,
    model,
  };
}

/**
 * Issues the token of one provider call that serves no session: reserved on
 * the budget account of its root first, so a call the account cannot hold
 * gets no token. The caller sends one Messages request with it through the
 * egress proxy, at most `maxTokens` out and `maxRequestBytes` in.
 */
export function createConversationCalls(deps: {
  store: ConversationCallStore;
  catalog: Pick<SessionCatalog, "connections">;
}) {
  const issueWith = async (
    input: {
      workspaceId: string;
      agentId: string;
      conversationId: ConversationId;
      topicId: ConversationTopicId | null;
      callClass: ConversationCallClass;
      /** The agent's active release (an agent_releases id). */
      releaseId: string | null;
      /** Unique in the agent with `attempt`; a retry takes the next attempt. */
      callKey: ConversationCallKey;
      attempt: number;
      root: BudgetRoot;
      connectionId: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
    },
    ttlMs = CONVERSATION_CALL_TOKEN_TTL_MS,
  ): Promise<ConversationCallIssued> => {
    for (const [name, value] of [
      ["maxTokens", input.maxTokens],
      ["maxRequestBytes", input.maxRequestBytes],
      ["attempt", input.attempt],
      ["ttlMs", ttlMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer: ${value}`);
      }
    }
    if (!input.callKey.endsWith(`:${input.callClass}`)) {
      throw new RangeError(
        `call key ${input.callKey} is not of class ${input.callClass}`,
      );
    }
    const found = callConnection(deps.catalog, input.connectionId, input.model);
    if ("reason" in found)
      return { outcome: "unavailable", reason: found.reason };
    const { connection } = found;
    const callId = conversationCallIdSchema.parse(crypto.randomUUID());
    const token = `${CONVERSATION_CALL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const issued = await deps.store.issueAtomic({
      ...input,
      callId,
      tokenHash: hashConversationCallToken(token),
      path: CONVERSATION_CALL_PATH,
      reserve: conversationCallReserve(input),
      unmetered: connection.provider.billing === "none",
      ttlMs,
    });
    if (issued.outcome !== "issued") return issued;
    return { outcome: "issued", callId, token, expiresAt: issued.expiresAt };
  };
  type Issue = Parameters<typeof issueWith>[0];
  return {
    /** Every call but an operator's own: its root and its key prefix are refused here. */
    async issue(input: Issue): Promise<ConversationCallIssued> {
      if (
        (input.root.kind === "key" && input.root.keyKind === "operator") ||
        input.callKey.startsWith(OPERATOR_CALL_KEY_PREFIX)
      ) {
        throw new RangeError(
          "An operator's call is issued by issueForOperator alone",
        );
      }
      return issueWith(input);
    },
    /**
     * The one call of a turn an operator started by hand, for the operator's
     * command alone: nothing a person, a key or Slack reaches calls this.
     * Charged to the agent's team as an operator key's call, which runs
     * whether or not the team has a limit.
     */
    async issueForOperator(
      input: Omit<Issue, "root" | "callKey" | "attempt"> & {
        /** The turn the call is for. */
        turnId: string;
        /**
         * How long the permit lasts: the turn's wait to be taken and then
         * its lease. The proxy asks again while the call runs, and a permit
         * that ended by then cuts a turn still inside its own limit.
         */
        ttlMs: number;
      },
    ): Promise<ConversationCallIssued> {
      const { turnId, ttlMs, ...call } = input;
      return issueWith(
        {
          ...call,
          root: OPERATOR_ROOT,
          callKey: conversationCallKeySchema.parse(
            `${OPERATOR_CALL_KEY_PREFIX}${turnId}:${call.callClass}`,
          ),
          attempt: 1,
        },
        ttlMs,
      );
    },
  };
}

export type ConversationCalls = ReturnType<typeof createConversationCalls>;
