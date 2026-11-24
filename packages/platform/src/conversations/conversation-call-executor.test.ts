import { describe, expect, test } from "bun:test";
import {
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
} from "@werft-ai/contracts";
import type { ConversationCalls } from "../limits/index.ts";
import {
  OutboundRefusedError,
  type OutboundRequest,
  type OutboundResponse,
} from "../ports/outbound-http.ts";
import {
  CONVERSATION_CALL_TIMEOUT_MS,
  type ConversationCallRequest,
  createConversationCallExecutor,
} from "./conversation-call-executor.ts";

const CALL_ID = conversationCallIdSchema.parse(crypto.randomUUID());
const TOKEN = ["wec", "one-call"].join("_");
// Words that must reach no log: the prompt's and the answer's.
const PROMPT = "prompt-text-that-stays-private";
const ANSWER = "answer-text-that-stays-private";

type Issue = Awaited<ReturnType<ConversationCalls["issue"]>>;

const answered = (status: number, body: unknown): OutboundResponse => ({
  status,
  text: typeof body === "string" ? body : JSON.stringify(body),
  headers: new Headers(),
});

const messagesAnswer = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
});

function harness(options: {
  issue?: () => Issue | Promise<Issue>;
  answer?: () => OutboundResponse | Promise<OutboundResponse>;
}) {
  const issues: Parameters<ConversationCalls["issue"]>[0][] = [];
  const requests: OutboundRequest[] = [];
  const logs: unknown[] = [];
  const executor = createConversationCallExecutor({
    calls: {
      async issue(input) {
        issues.push(input);
        return options.issue
          ? options.issue()
          : {
              outcome: "issued",
              callId: CALL_ID,
              token: TOKEN,
              expiresAt: new Date(Date.now() + 120_000),
            };
      },
    },
    egressUrl: "http://egress-proxy:3129/",
    http: async (request) => {
      requests.push(request);
      return options.answer
        ? options.answer()
        : answered(200, messagesAnswer(`<decision>${ANSWER}</decision>`));
    },
    logger: { warn: (message, fields) => logs.push({ message, fields }) },
  });
  return { executor, issues, requests, logs };
}

const request: ConversationCallRequest<string> = {
  workspaceId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  conversationId: conversationIdSchema.parse(crypto.randomUUID()),
  topicId: conversationTopicIdSchema.parse(crypto.randomUUID()),
  callClass: "m1",
  releaseId: "release-1",
  callKey: conversationCallKeySchema.parse(`${crypto.randomUUID()}:m1`),
  attempt: 2,
  root: { kind: "none" },
  connectionId: "conn-1",
  model: "claude-haiku-5",
  maxTokens: 64,
  system: "Answer inside <decision></decision>.",
  messages: [{ role: "user", content: PROMPT }],
  parse: (text) => /^<decision>(.+)<\/decision>$/.exec(text)?.[1] ?? null,
};

describe("createConversationCallExecutor", () => {
  test("an answered call returns the parsed answer, sent once with its token to the proxy's provider route", async () => {
    const { executor, issues, requests, logs } = harness({});
    expect(await executor.run(request)).toEqual({
      outcome: "answered",
      callId: CALL_ID,
      value: ANSWER,
    });
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.url).toBe("http://egress-proxy:3129/provider/v1/messages");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers?.["x-api-key"]).toBe(TOKEN);
    expect(sent?.timeoutMs).toBe(CONVERSATION_CALL_TIMEOUT_MS);
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
    });
    // Reserved for the very request sent.
    expect(issues).toEqual([
      {
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        conversationId: request.conversationId,
        topicId: request.topicId,
        callClass: request.callClass,
        releaseId: request.releaseId,
        callKey: request.callKey,
        attempt: request.attempt,
        root: request.root,
        connectionId: request.connectionId,
        model: request.model,
        maxTokens: request.maxTokens,
        maxRequestBytes: Buffer.byteLength(sent?.body ?? ""),
      },
    ]);
    expect(logs).toEqual([]);
  });

  test("a refused reservation never calls the provider", async () => {
    const { executor, requests } = harness({
      issue: () => ({ outcome: "refused", rootKind: "none", accountId: null }),
    });
    expect(await executor.run(request)).toEqual({
      outcome: "refused",
      rootKind: "none",
      accountId: null,
    });
    expect(requests).toHaveLength(0);
  });

  test("no such agent, a connection the catalog lacks, and a failed reservation never call the provider", async () => {
    for (const [issue, outcome] of [
      [() => ({ outcome: "unknown_agent" }) as const, "unknown_agent"],
      [
        () => ({ outcome: "unknown_conversation" }) as const,
        "unknown_conversation",
      ],
      [() => ({ outcome: "already_issued" }) as const, "already_issued"],
      [() => ({ outcome: "unavailable" }) as const, "unavailable"],
      [
        () => {
          throw new Error("connection reset");
        },
        "issue_failed",
      ],
    ] as const) {
      const { executor, requests } = harness({ issue });
      expect(await executor.run(request)).toEqual({ outcome } as never);
      expect(requests).toHaveLength(0);
    }
  });

  test("a parser that throws makes the answer malformed, and its error is not logged", async () => {
    const { executor, logs } = harness({});
    expect(
      await executor.run({
        ...request,
        parse: (text) => {
          throw new SyntaxError(`not JSON: ${text}`);
        },
      }),
    ).toEqual({ outcome: "malformed", callId: CALL_ID, retryable: false });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(ANSWER);
  });

  test("each way a call goes wrong is a named result, and no log holds the prompt or the answer", async () => {
    const cases: Array<{
      answer: () => OutboundResponse;
      result: Record<string, unknown>;
    }> = [
      {
        answer: () => {
          throw new OutboundRefusedError("unreachable", "Request failed", {
            timedOut: true,
          });
        },
        result: { outcome: "timed_out", retryable: true },
      },
      {
        answer: () => {
          throw new OutboundRefusedError("unreachable", "Request failed");
        },
        result: { outcome: "unreachable", retryable: true },
      },
      {
        answer: () => {
          throw new OutboundRefusedError("answered", "Server answered 529", {
            status: 529,
          });
        },
        result: { outcome: "provider_error", status: 529, retryable: true },
      },
      {
        answer: () => answered(500, { error: { message: ANSWER } }),
        result: { outcome: "provider_error", status: 500, retryable: true },
      },
      {
        answer: () => answered(429, { error: { message: ANSWER } }),
        result: { outcome: "provider_error", status: 429, retryable: true },
      },
      {
        answer: () => answered(400, { error: { message: ANSWER } }),
        result: { outcome: "provider_error", status: 400, retryable: false },
      },
      {
        answer: () =>
          answered(200, `{"content":[{"type":"text","text":"${ANSWER}`),
        result: { outcome: "malformed", retryable: false },
      },
      {
        answer: () => answered(200, { content: [{ type: "tool_use" }] }),
        result: { outcome: "malformed", retryable: false },
      },
      {
        answer: () => answered(200, messagesAnswer(`no tag: ${ANSWER}`)),
        result: { outcome: "malformed", retryable: false },
      },
    ];
    for (const { answer, result } of cases) {
      const { executor, requests, logs } = harness({ answer });
      expect(await executor.run(request)).toEqual({
        ...result,
        callId: CALL_ID,
      } as never);
      expect(requests).toHaveLength(1);
      expect(logs).toHaveLength(1);
      const logged = JSON.stringify(logs);
      expect(logged).not.toContain(ANSWER);
      expect(logged).not.toContain(PROMPT);
      expect(logged).not.toContain(TOKEN);
    }
  });
});
