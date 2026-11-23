import { randomBytes } from "node:crypto";
import {
  type ConversationCallId,
  conversationCallIdSchema,
} from "@werft-ai/contracts";
import { connectionOf, type SessionCatalog } from "../catalog/index.ts";
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
  // The connection is not one the catalog holds, or serves no Messages.
  | { outcome: "unavailable" };

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
  return {
    async issue(input: {
      workspaceId: string;
      agentId: string;
      root: BudgetRoot;
      connectionId: string;
      model: string;
      maxTokens: number;
      maxRequestBytes: number;
    }): Promise<ConversationCallIssued> {
      for (const [name, value] of [
        ["maxTokens", input.maxTokens],
        ["maxRequestBytes", input.maxRequestBytes],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new RangeError(`${name} must be a positive integer: ${value}`);
        }
      }
      const connection = connectionOf(deps.catalog, input.connectionId);
      if (!connection || connection.provider.kind === "openai_responses") {
        return { outcome: "unavailable" };
      }
      const callId = conversationCallIdSchema.parse(crypto.randomUUID());
      const token = `${CONVERSATION_CALL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const issued = await deps.store.issueAtomic({
        ...input,
        callId,
        tokenHash: hashConversationCallToken(token),
        path: CONVERSATION_CALL_PATH,
        reserve: conversationCallReserve(input),
        unmetered: connection.provider.billing === "none",
        ttlMs: CONVERSATION_CALL_TOKEN_TTL_MS,
      });
      if (issued.outcome !== "issued") return issued;
      return { outcome: "issued", callId, token, expiresAt: issued.expiresAt };
    },
  };
}

export type ConversationCalls = ReturnType<typeof createConversationCalls>;
