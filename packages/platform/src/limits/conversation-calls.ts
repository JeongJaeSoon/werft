import { randomBytes } from "node:crypto";
import {
  type AgentRelease,
  CONVERSATION_TURN_LIMIT_VALUES,
  type ConversationCallClass,
  type ConversationCallId,
  type ConversationCallKey,
  type ConversationId,
  type ConversationKind,
  type ConversationTopicId,
  type ConversationTurnCallRefusal,
  type ConversationTurnId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  releaseJudgmentModel,
} from "@werft-ai/contracts";
import {
  connectionModels,
  connectionOf,
  type SessionCatalog,
} from "../catalog/index.ts";
import type { ConversationTurnSurfaceSubject } from "../conversations/index.ts";
import type { ConversationTurnOutcome } from "../ports/conversation-turn-queue.ts";
import { hashToken } from "../token-hash.ts";
import type { BudgetRoot } from "./budget-accounts.ts";
import type { ProviderUsage } from "./model-prices.ts";
import type {
  ConversationCallIssue,
  ConversationCallStore,
  ConversationMentionTurnIssue,
  ConversationUnsolicitedTurnIssue,
  ConversationTurnLimitReached,
  ConversationTurnPermitIssue,
} from "./ports/conversation-call-store.ts";
import { reservationCostUsd, reservationTokens } from "./reservations.ts";

export const CONVERSATION_CALL_TOKEN_PREFIX = "wec_";
// A conversation turn's permit, good for each of its calls while it runs.
export const CONVERSATION_TURN_PERMIT_TOKEN_PREFIX = "wct_";
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
 * Which limit ended a turn and who held it there: the server, when it
 * refused a call past the turn's count or the turn's lease ran out; else the
 * runtime, by the reason it reported. A tool call the server refused past
 * its count is the runtime's when the runtime reported that limit itself:
 * its cut and the call already on its way race, which a model call's do not.
 */
export function conversationTurnLimitReached(
  outcome: ConversationTurnOutcome | null,
  refusal: ConversationTurnCallRefusal | null,
  toolCallRefused = false,
): ConversationTurnLimitReached | null {
  if (refusal === "turn_limit") {
    return { limit: "model_call_limit", by: "server" };
  }
  const reported = outcome?.outcome === "failed" ? outcome.reason : undefined;
  if (toolCallRefused && reported !== "tool_call_limit") {
    return { limit: "tool_call_limit", by: "server" };
  }
  if (outcome?.outcome !== "failed") return null;
  if (outcome.reason === "lease_expired") {
    return { limit: "time_limit", by: "server" };
  }
  const limit = CONVERSATION_TURN_LIMIT_VALUES.find(
    (value) => value === outcome.reason,
  );
  return limit === undefined ? null : { limit, by: "runner" };
}

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

export type ConversationTurnPermitIssued =
  | {
      outcome: "issued";
      /** Sent as the API key of each of the turn's calls to the proxy's provider route. */
      token: string;
      expiresAt: Date;
      /** The conversation's kind, which says what the turn may decide. */
      place: ConversationKind;
    }
  | Exclude<ConversationTurnPermitIssue, { outcome: "issued" }>
  | { outcome: "unavailable"; reason: ConversationCallUnavailable };

export type ConversationMentionTurnIssued =
  | ConversationTurnPermitIssued
  | Exclude<ConversationMentionTurnIssue, ConversationTurnPermitIssue>;

export type ConversationUnsolicitedTurnIssued =
  | (Extract<ConversationTurnPermitIssued, { outcome: "issued" }> & {
      topicId: ConversationTopicId;
    })
  | Exclude<ConversationTurnPermitIssued, { outcome: "issued" }>
  | Exclude<
      ConversationUnsolicitedTurnIssue,
      { outcome: ConversationTurnPermitIssue["outcome"] }
    >;

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
          "An operator's calls are issued by issueOperatorTurn alone",
        );
      }
      return issueWith(input);
    },
    /**
     * A turn an operator started by hand, for the operator's command alone:
     * nothing a person, a key or Slack reaches calls this. Writes the turn
     * and its permit; each provider call the turn makes on the permit is
     * reserved when the proxy asks for it, charged to the agent's team as an
     * operator key's call, which runs whether or not the team has a limit.
     */
    async issueOperatorTurn(input: {
      workspaceId: string;
      agentId: string;
      conversationId: ConversationId;
      topicId: ConversationTopicId;
      turnId: ConversationTurnId;
      /** Who ran the command, kept as the turn's requester. */
      operator: string;
      releaseId: string | null;
      connectionId: string;
      model: string;
      /** What each call of the turn may use. */
      maxTokens: number;
      maxRequestBytes: number;
      /**
       * How long the permit lasts: the turn's wait to be taken and then its
       * lease. The proxy asks again while a call runs, and a permit that
       * ended by then cuts a turn still inside its own limit.
       */
      ttlMs: number;
    }): Promise<ConversationTurnPermitIssued> {
      for (const [name, value] of [
        ["maxTokens", input.maxTokens],
        ["maxRequestBytes", input.maxRequestBytes],
        ["ttlMs", input.ttlMs],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new RangeError(`${name} must be a positive integer: ${value}`);
        }
      }
      const found = callConnection(
        deps.catalog,
        input.connectionId,
        input.model,
      );
      if ("reason" in found)
        return { outcome: "unavailable", reason: found.reason };
      const { operator, ...turn } = input;
      const token = `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const issued = await deps.store.issueTurnPermitAtomic({
        ...turn,
        tokenHash: hashConversationCallToken(token),
        requester: { kind: "operator", id: operator },
        root: OPERATOR_ROOT,
        path: CONVERSATION_CALL_PATH,
        callKey: conversationCallKeySchema.parse(
          `${OPERATOR_CALL_KEY_PREFIX}${input.turnId}:m2`,
        ),
      });
      if (issued.outcome !== "issued") return issued;
      return {
        outcome: "issued",
        token,
        expiresAt: issued.expiresAt,
        place: issued.place,
      };
    },
    /**
     * A person's mention of the agent in Slack as a turn: writes the turn,
     * its permit and the mention's engagement. The person is the turn's
     * requester as the server knows them, and each provider call the turn
     * makes on the permit is reserved on their budget when the proxy asks.
     */
    async issueMentionTurn(input: {
      workspaceId: string;
      agentId: string;
      conversationId: ConversationId;
      topicId: ConversationTopicId;
      turnId: ConversationTurnId;
      requesterUserId: string;
      slackInstallationId: string;
      message: { teamId: string; channelId: string; ts: string };
      slackSubject: ConversationTurnSurfaceSubject | null;
      /** The mention's earlier try this turn tries again. */
      retryOf?: ConversationTurnId;
      releaseId: string | null;
      connectionId: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
      ttlMs: number;
    }): Promise<ConversationMentionTurnIssued> {
      for (const [name, value] of [
        ["maxTokens", input.maxTokens],
        ["maxRequestBytes", input.maxRequestBytes],
        ["ttlMs", input.ttlMs],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new RangeError(`${name} must be a positive integer: ${value}`);
        }
      }
      const found = callConnection(
        deps.catalog,
        input.connectionId,
        input.model,
      );
      if ("reason" in found)
        return { outcome: "unavailable", reason: found.reason };
      const token = `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const issued = await deps.store.issueMentionTurnAtomic({
        ...input,
        tokenHash: hashConversationCallToken(token),
        path: CONVERSATION_CALL_PATH,
        callKey: conversationCallKeySchema.parse(`${input.turnId}:m2`),
      });
      if (issued.outcome !== "issued") return issued;
      return {
        outcome: "issued",
        token,
        expiresAt: issued.expiresAt,
        place: issued.place,
      };
    },
    /**
     * The agent's own answer to a message M1 judged "speak" (v1-b/U1): no
     * person asked, so the turn's requester is the agent and each call on its
     * permit is reserved on the agent's team (root none), under the team's
     * 80% rule.
     */
    async issueUnsolicitedTurn(input: {
      workspaceId: string;
      agentId: string;
      conversationId: ConversationId;
      turnId: ConversationTurnId;
      message: {
        teamId: string;
        channelId: string;
        ts: string;
        threadTs: string;
      };
      releaseId: string | null;
      connectionId: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
      ttlMs: number;
    }): Promise<ConversationUnsolicitedTurnIssued> {
      for (const [name, value] of [
        ["maxTokens", input.maxTokens],
        ["maxRequestBytes", input.maxRequestBytes],
        ["ttlMs", input.ttlMs],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new RangeError(`${name} must be a positive integer: ${value}`);
        }
      }
      const found = callConnection(
        deps.catalog,
        input.connectionId,
        input.model,
      );
      if ("reason" in found)
        return { outcome: "unavailable", reason: found.reason };
      const token = `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const issued = await deps.store.issueUnsolicitedTurnAtomic({
        ...input,
        tokenHash: hashConversationCallToken(token),
        path: CONVERSATION_CALL_PATH,
        callKey: conversationCallKeySchema.parse(`${input.turnId}:m2`),
      });
      if (issued.outcome !== "issued") return issued;
      return {
        outcome: "issued",
        token,
        expiresAt: issued.expiresAt,
        place: issued.place,
        topicId: issued.topicId,
      };
    },
    /**
     * Ends a turn issued here once its runtime is done with it, and its
     * permit with it: no call is granted on it after this.
     */
    endTurn(turnId: ConversationTurnId, outcome?: ConversationTurnOutcome) {
      // A decision is the server's, written as its tool was called: what the
      // runtime reports of one does not change the record.
      return deps.store.endTurnAtomic({
        turnId,
        limitReached: (refusal, toolCallRefused) =>
          conversationTurnLimitReached(
            outcome ?? null,
            refusal,
            toolCallRefused,
          ),
      });
    },
    /**
     * Holds a turn's permit to its runtime's lease: once the lease is out,
     * no call is granted on it, whatever the runtime does.
     */
    boundTurnPermit(turnId: ConversationTurnId, until: Date) {
      return deps.store.boundTurnPermitAtomic({ turnId, until });
    },
  };
}

export type ConversationCalls = ReturnType<typeof createConversationCalls>;
