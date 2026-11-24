import type {
  BudgetAccountId,
  BudgetRootKind,
  ConversationCallId,
} from "@werft-ai/contracts";
import type { BudgetRoot, ConversationCalls } from "../limits/index.ts";
import { CONVERSATION_CALL_PATH } from "../limits/index.ts";
import {
  type OutboundHttp,
  OutboundRefusedError,
} from "../ports/outbound-http.ts";

// Under the proxy's 30s regrant: the token is bound by the first grant, so an
// exchange still open at the regrant is cut, and the call left unknown.
export const CONVERSATION_CALL_TIMEOUT_MS = 25_000;

export type ConversationCallMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationCallRequest<T> = {
  workspaceId: string;
  agentId: string;
  root: BudgetRoot;
  connectionId: string;
  model: string;
  maxTokens: number;
  system: string;
  messages: readonly ConversationCallMessage[];
  /**
   * Reads the answer's text into the shape the caller asked the model for;
   * null when the text is not that shape.
   */
  parse: (text: string) => T | null;
};

/**
 * One call, one reservation: a result marked `retryable` may be tried again
 * as a new run, which reserves again.
 */
export type ConversationCallResult<T> =
  | { outcome: "answered"; callId: ConversationCallId; value: T }
  // Not reserved, so the provider was never called.
  | {
      outcome: "refused";
      rootKind: BudgetRootKind;
      accountId: BudgetAccountId | null;
    }
  | { outcome: "unknown_agent" }
  // The connection is not one the catalog holds, or serves no Messages.
  | { outcome: "unavailable" }
  // The reservation itself failed; nothing was reserved.
  | { outcome: "issue_failed" }
  | { outcome: "timed_out"; callId: ConversationCallId; retryable: true }
  | { outcome: "unreachable"; callId: ConversationCallId; retryable: true }
  | {
      outcome: "provider_error";
      callId: ConversationCallId;
      status: number;
      retryable: boolean;
    }
  // Not JSON, not a Messages answer, or text `parse` did not take.
  | { outcome: "malformed"; callId: ConversationCallId; retryable: false };

type Logger = {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

/**
 * Runs one provider call that serves no session: reserved and given a
 * one-call token first, then sent as one Messages request through the egress
 * proxy's provider route, which puts the connection's credential on it and
 * settles the reservation from what it used. Never throws; nothing of the
 * prompt or the answer is logged.
 */
export function createConversationCallExecutor(deps: {
  calls: Pick<ConversationCalls, "issue">;
  // The proxy's credential listener, e.g. http://egress-proxy:3129.
  egressUrl: string;
  /** Held to the egress proxy's host alone. */
  http: OutboundHttp;
  logger: Logger;
  timeoutMs?: number;
}) {
  const base = deps.egressUrl.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? CONVERSATION_CALL_TIMEOUT_MS;

  return {
    async run<T>(
      input: ConversationCallRequest<T>,
    ): Promise<ConversationCallResult<T>> {
      const body = JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: input.messages,
      });
      let issued: Awaited<ReturnType<ConversationCalls["issue"]>>;
      try {
        issued = await deps.calls.issue({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          root: input.root,
          connectionId: input.connectionId,
          model: input.model,
          maxTokens: input.maxTokens,
          // The body as sent, so the reservation holds exactly this request.
          maxRequestBytes: Buffer.byteLength(body),
        });
      } catch (error) {
        deps.logger.warn("Conversation call not reserved", {
          agent_id: input.agentId,
          error: error instanceof Error ? error.name : "error",
        });
        return { outcome: "issue_failed" };
      }
      if (issued.outcome !== "issued") return issued;
      const { callId } = issued;
      const failed = <R extends ConversationCallResult<T>>(result: R): R => {
        deps.logger.warn("Conversation call failed", {
          call_id: callId,
          outcome: result.outcome,
          ...("status" in result ? { status: result.status } : {}),
        });
        return result;
      };

      let response: Awaited<ReturnType<OutboundHttp>>;
      try {
        response = await deps.http({
          url: `${base}/provider${CONVERSATION_CALL_PATH}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": issued.token,
          },
          body,
          timeoutMs,
        });
      } catch (error) {
        if (error instanceof OutboundRefusedError) {
          const { status, timedOut } = error.detail;
          if (error.reason === "answered" && status !== undefined) {
            return failed({
              outcome: "provider_error",
              callId,
              status,
              retryable: true,
            });
          }
          if (timedOut === true) {
            return failed({ outcome: "timed_out", callId, retryable: true });
          }
        }
        return failed({ outcome: "unreachable", callId, retryable: true });
      }
      if (response.status < 200 || response.status > 299) {
        return failed({
          outcome: "provider_error",
          callId,
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const text = answerText(response.text);
      const value = text === null ? null : input.parse(text);
      if (value === null) {
        return failed({ outcome: "malformed", callId, retryable: false });
      }
      return { outcome: "answered", callId, value };
    },
  };
}

export type ConversationCallExecutor = ReturnType<
  typeof createConversationCallExecutor
>;

/** The text blocks of a Messages answer, joined; null for anything else. */
function answerText(raw: string): string | null {
  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof answer !== "object" || answer === null) return null;
  const { content } = answer as { content?: unknown };
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) return [];
    const { type, text } = block as { type?: unknown; text?: unknown };
    return type === "text" && typeof text === "string" ? [text] : [];
  });
  return texts.length === 0 ? null : texts.join("");
}
