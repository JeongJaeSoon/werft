import { describe, expect, test } from "bun:test";
import {
  type ConversationRuntimeTurn,
  conversationRuntimeIdSchema,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import { type FetchLike, HttpConversationTurnSource } from "./turn-source.ts";

const BEARER = ["runtime", "bearer", "0123456789abcdef0123456789"].join("-");
const runtimeId = conversationRuntimeIdSchema.parse(crypto.randomUUID());

const turn: ConversationRuntimeTurn = conversationRuntimeTurnSchema.parse({
  turn_id: crypto.randomUUID(),
  lease_id: crypto.randomUUID(),
  lease_expires_at: "2026-11-24T00:02:30.000Z",
  scope: {
    workspace_id: crypto.randomUUID(),
    agent_id: crypto.randomUUID(),
    conversation_id: crypto.randomUUID(),
    topic_id: crypto.randomUUID(),
  },
  model: "claude-haiku-5",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "egress_token", token: ["wec", "one-call"].join("_") },
  },
  call: { max_tokens: 1_024 },
  input: { id: crypto.randomUUID(), text: "hello" },
  fresh_input: { id: crypto.randomUUID(), text: "hello" },
});

function source(answer: (path: string, body: unknown) => Response) {
  const calls: Array<{
    url: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body,
    });
    return answer(new URL(url).pathname, body);
  };
  return {
    calls,
    source: new HttpConversationTurnSource({
      baseUrl: "http://api:3000/",
      token: BEARER,
      runtimeId,
      waitMs: 20_000,
      requestTimeoutMs: 30_000,
      fetch,
    }),
  };
}

const live = new AbortController().signal;
const problem = (status: number, code: string) =>
  Response.json(
    { error: { code, message: "said by the server", retryable: false } },
    { status },
  );

describe("HttpConversationTurnSource", () => {
  test("polls the next-turn route with its bearer and id, and returns the turn or none", async () => {
    let next: ConversationRuntimeTurn | null = turn;
    const { source: s, calls } = source(() => Response.json({ turn: next }));

    expect(await s.next(live)).toEqual(turn);
    next = null;
    expect(await s.next(live)).toBeNull();

    expect(calls[0]).toEqual({
      url: "http://api:3000/internal/conversation-runtime/next-turn",
      authorization: `Bearer ${BEARER}`,
      body: { runtime_id: runtimeId, wait_ms: 20_000 },
    });
  });

  test("a refused or malformed poll throws, without the bearer or the answer's text", async () => {
    for (const answer of [
      () => problem(403, "FORBIDDEN"),
      () => new Response("upstream said no", { status: 502 }),
      () => Response.json({ turn: { turn_id: "not-a-turn" } }),
    ]) {
      const { source: s } = source(answer);
      let message = "";
      try {
        await s.next(live);
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(BEARER);
      expect(message).not.toContain("said by the server");
      expect(message).not.toContain("upstream said no");
    }
  });

  test("reports a turn under its lease; a repeat the server already has is still recorded", async () => {
    const { source: s, calls } = source((_path, _body) =>
      Response.json({ recorded: false }),
    );
    const result = { outcome: "completed", text: "answer" } as const;

    expect(await s.report(turn, result)).toBe("recorded");

    expect(calls[0]).toEqual({
      url: "http://api:3000/internal/conversation-runtime/turn-result",
      authorization: `Bearer ${BEARER}`,
      body: {
        runtime_id: runtimeId,
        turn_id: turn.turn_id,
        lease_id: turn.lease_id,
        result,
      },
    });
  });

  test("the server's verdict on a report is final; an outage is thrown to be retried", async () => {
    const failed = { outcome: "failed", reason: "engine_failed" } as const;
    for (const [status, code] of [
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "REQUEST_EXPIRED"],
      [409, "IDEMPOTENCY_CONFLICT"],
    ] as const) {
      const { source: s } = source(() => problem(status, code));
      expect(await s.report(turn, failed)).toBe("refused");
    }
    for (const status of [500, 502, 503]) {
      const { source: s } = source(() =>
        problem(status, "BACKEND_UNAVAILABLE"),
      );
      await expect(s.report(turn, failed)).rejects.toThrow(String(status));
    }
  });

  test("a read tool call names the turn, its lease and the tool alone; the server's verdict on the turn is turn_not_held", async () => {
    const { calls, source: s } = source(() =>
      Response.json({ outcome: "read", text: "{}" }),
    );
    expect(await s.readTool(turn, "read_turns", live)).toEqual({
      outcome: "read",
      text: "{}",
    });
    expect(calls).toEqual([
      {
        url: "http://api:3000/internal/conversation-runtime/read-tool",
        authorization: expect.stringMatching(/^Bearer /),
        body: {
          runtime_id: runtimeId,
          turn_id: turn.turn_id,
          lease_id: turn.lease_id,
          tool: "read_turns",
        },
      },
    ]);
    for (const [status, code] of [
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "REQUEST_EXPIRED"],
    ] as const) {
      const { source: refused } = source(() => problem(status, code));
      expect(await refused.readTool(turn, "read_thread", live)).toEqual({
        outcome: "turn_not_held",
      });
    }
    const { source: down } = source(() => problem(503, "BACKEND_UNAVAILABLE"));
    await expect(down.readTool(turn, "read_thread", live)).rejects.toThrow(
      "503",
    );
    // An answer off the schema is not handed to the model.
    const { source: odd } = source(() =>
      Response.json({ outcome: "read", text: "x".repeat(20_000) }),
    );
    await expect(odd.readTool(turn, "read_thread", live)).rejects.toThrow();
  });
});
