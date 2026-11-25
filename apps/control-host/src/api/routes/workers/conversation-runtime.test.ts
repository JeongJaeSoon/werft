import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  CONVERSATION_TURN_LEASE_MS,
  type ConversationRuntimeTurn,
  conversationIdSchema,
  conversationInputIdSchema,
  conversationNextTurnResponseSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  WORKER_PROTOCOL_ROUTES,
} from "@werft-ai/contracts";
import {
  type ConversationReadTools,
  createConversationRuntimeTurns,
  createMemoryConversationTurnQueue,
  type WorkerGateway,
  WorkerGatewayError,
} from "@werft-ai/platform";
import { createApiApp } from "../../app.ts";
import { conversationRuntimeBearer } from "../../conversation-runtime.ts";
import { registerConversationRuntimeRoutes } from "./conversation-runtime.ts";
import { registerWorkerRoutes } from "./worker.ts";

const CURRENT = ["runtime", "bearer", "current", "0123456789abcdef"].join("-");
const PREVIOUS = ["runtime", "bearer", "previous", "0123456789abcdef"].join(
  "-",
);
const WORKER = ["a", "session", "worker", "token"].join("-");
const runtimeId = crypto.randomUUID();

function harness() {
  const readCalls: unknown[] = [];
  let readAnswer: Awaited<ReturnType<ConversationReadTools["call"]>> = {
    outcome: "read",
    text: "{}",
  };
  const decideCalls: unknown[] = [];
  let decideAnswer: Awaited<ReturnType<ConversationReadTools["decide"]>> = {
    outcome: "accepted",
  };
  const readTools: Pick<ConversationReadTools, "call" | "decide"> = {
    async call(input) {
      readCalls.push(input);
      return readAnswer;
    },
    async decide(input) {
      decideCalls.push(input);
      return decideAnswer;
    },
  };
  let clock = Date.parse("2026-11-24T00:00:00.000Z");
  const turns = createConversationRuntimeTurns({
    queue: createMemoryConversationTurnQueue(),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
  });
  // A gateway that knows no bearer but a session worker's.
  const authenticated: Array<string | null> = [];
  const gateway = {
    async authenticate(token: string | null) {
      authenticated.push(token);
      if (token !== WORKER) {
        throw new WorkerGatewayError(401, "UNAUTHORIZED", "Unknown credential");
      }
      return { kind: "bootstrap" };
    },
    async heartbeat() {
      return { ok: true };
    },
  } as unknown as WorkerGateway;
  const app = createApiApp({
    authMode: "api-key",
    registerInternalRoutes: (router) => {
      registerConversationRuntimeRoutes(router, {
        turns,
        readTools,
        isRuntimeBearer: conversationRuntimeBearer([CURRENT, PREVIOUS]),
      });
      registerWorkerRoutes(router, gateway);
    },
  });
  const post = (path: string, token: string | null, body: unknown) =>
    app.request(`/internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });
  const enqueue = async () => {
    const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
    await turns.queue.enqueue(
      {
        turn_id: turnId,
        scope: {
          workspace_id: crypto.randomUUID(),
          agent_id: crypto.randomUUID(),
          conversation_id: conversationIdSchema.parse(crypto.randomUUID()),
          topic_id: conversationTopicIdSchema.parse(crypto.randomUUID()),
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
      },
      {
        inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
        attempt: 1,
        takeBy: new Date(clock + 30_000),
      },
    );
    return turnId;
  };
  const next = async (token: string = CURRENT, id = runtimeId) => {
    const response = await post("/conversation-runtime/next-turn", token, {
      runtime_id: id,
    });
    expect(response.status).toBe(200);
    return conversationNextTurnResponseSchema.parse(await response.json()).turn;
  };
  const report = (turn: ConversationRuntimeTurn, overrides = {}) =>
    post("/conversation-runtime/turn-result", CURRENT, {
      runtime_id: runtimeId,
      turn_id: turn.turn_id,
      lease_id: turn.lease_id,
      result: { outcome: "completed", text: "answer" },
      ...overrides,
    });
  return {
    turns,
    authenticated,
    post,
    enqueue,
    next,
    report,
    readCalls,
    answerReads(answer: typeof readAnswer) {
      readAnswer = answer;
    },
    decideCalls,
    answerDecisions(answer: typeof decideAnswer) {
      decideAnswer = answer;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

async function errorOf(response: Response) {
  const body = apiErrorResponseSchema.parse(await response.json());
  return { status: response.status, code: body.error.code };
}

describe("the conversation runtime's routes", () => {
  test("its bearer takes a turn and reports it; the same report again is recorded once", async () => {
    const h = harness();
    expect(await h.next()).toBeNull();
    const turnId = await h.enqueue();

    const turn = await h.next();
    if (turn === null) throw new Error("no turn");
    expect(turn.turn_id).toBe(turnId);
    expect(Date.parse(turn.lease_expires_at)).toBe(
      Date.parse("2026-11-24T00:00:00.000Z") + CONVERSATION_TURN_LEASE_MS,
    );

    const first = await h.report(turn);
    expect([first.status, await first.json()]).toEqual([
      200,
      { recorded: true },
    ]);
    const again = await h.report(turn);
    expect([again.status, await again.json()]).toEqual([
      200,
      { recorded: false },
    ]);
    expect(
      await errorOf(
        await h.report(turn, {
          result: { outcome: "completed", text: "other" },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(await h.turns.ended(turnId)).toEqual({
      outcome: "completed",
      text: "answer",
    });
  });

  test("the bearer being rotated out is taken beside the current one", async () => {
    const h = harness();
    const turnId = await h.enqueue();
    expect((await h.next(PREVIOUS))?.turn_id).toBe(turnId);
  });

  test("a report from another runtime or under another lease is refused; one after the lease ended finds the turn closed", async () => {
    const h = harness();
    const turnId = await h.enqueue();
    const turn = await h.next();
    if (turn === null) throw new Error("no turn");

    expect(
      await errorOf(await h.report(turn, { runtime_id: crypto.randomUUID() })),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      await errorOf(await h.report(turn, { lease_id: crypto.randomUUID() })),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      await errorOf(await h.report(turn, { turn_id: crypto.randomUUID() })),
    ).toEqual({ status: 404, code: "NOT_FOUND" });

    h.advance(CONVERSATION_TURN_LEASE_MS);
    expect(await errorOf(await h.report(turn))).toEqual({
      status: 409,
      code: "REQUEST_EXPIRED",
    });
    expect(await h.turns.ended(turnId)).toEqual({
      outcome: "failed",
      reason: "lease_expired",
    });
    // Closed, not requeued.
    expect(await h.next()).toBeNull();
  });

  test("no bearer is 401, and a session worker's credential is 403 on both routes", async () => {
    const h = harness();
    await h.enqueue();
    for (const path of [
      "/conversation-runtime/next-turn",
      "/conversation-runtime/turn-result",
      "/conversation-runtime/read-tool",
      "/conversation-runtime/decision-tool",
    ]) {
      expect(await errorOf(await h.post(path, null, {}))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(
        await errorOf(await h.post(path, WORKER, { runtime_id: runtimeId })),
      ).toEqual({
        status: 403,
        code: "FORBIDDEN",
      });
    }
    // Nothing was handed out to the refused callers.
    expect((await h.next())?.turn_id).toBeDefined();
    expect(h.readCalls).toEqual([]);
    expect(h.decideCalls).toEqual([]);
  });

  test("a decision tool call carries one decision of a listed tool, in its shape; the service's verdict on the turn is its status", async () => {
    const h = harness();
    const call = {
      runtime_id: runtimeId,
      turn_id: crypto.randomUUID(),
      lease_id: crypto.randomUUID(),
      decision: { tool: "reply", body: "Here it is.", reason: "asked" },
    };
    const decide = (body: unknown) =>
      h.post("/conversation-runtime/decision-tool", CURRENT, body);

    const answered = await decide(call);
    expect([answered.status, await answered.json()]).toEqual([
      200,
      { outcome: "accepted" },
    ]);
    expect(h.decideCalls).toEqual([
      {
        runtimeId: call.runtime_id,
        turnId: call.turn_id,
        leaseId: call.lease_id,
        decision: call.decision,
      },
    ]);
    h.answerDecisions({ outcome: "refused", reason: "tool_not_allowed" });
    const refused = await decide({
      ...call,
      decision: {
        tool: "spawn_task",
        spec: "write the report",
        reason: "needs work",
      },
    });
    expect([refused.status, await refused.json()]).toEqual([
      200,
      { outcome: "refused", reason: "tool_not_allowed" },
    ]);

    // Another tool, a field another tool takes, none of reason, or a bad task id.
    for (const decision of [
      { tool: "post_message", body: "x", reason: "r" },
      { tool: "reply", body: "x", reason: "r", channel: "C0OTHER" },
      { tool: "no_reply", reason: "r", body: "x" },
      { tool: "no_reply" },
      { tool: "reply", body: "", reason: "r" },
      { tool: "route_to_task", task_id: "task-1", reason: "r" },
    ]) {
      expect((await errorOf(await decide({ ...call, decision }))).status).toBe(
        400,
      );
    }
    expect(h.decideCalls).toHaveLength(2);

    for (const [outcome, status, code] of [
      ["unknown_turn", 404, "NOT_FOUND"],
      ["not_holder", 403, "FORBIDDEN"],
      ["lease_expired", 409, "REQUEST_EXPIRED"],
    ] as const) {
      h.answerDecisions({ outcome });
      expect(await errorOf(await decide(call))).toEqual({ status, code });
    }
  });

  test("a read tool call names one listed tool and nothing else; the service's verdict on the turn is its status", async () => {
    const h = harness();
    const call = {
      runtime_id: runtimeId,
      turn_id: crypto.randomUUID(),
      lease_id: crypto.randomUUID(),
      tool: "read_thread",
    };
    const read = (body: unknown) =>
      h.post("/conversation-runtime/read-tool", CURRENT, body);

    const answered = await read(call);
    expect([answered.status, await answered.json()]).toEqual([
      200,
      { outcome: "read", text: "{}" },
    ]);
    expect(h.readCalls).toEqual([
      {
        runtimeId: call.runtime_id,
        turnId: call.turn_id,
        leaseId: call.lease_id,
        tool: "read_thread",
      },
    ]);

    h.answerReads({ outcome: "refused", reason: "thread_read_limit" });
    const refused = await read(call);
    expect([refused.status, await refused.json()]).toEqual([
      200,
      { outcome: "refused", reason: "thread_read_limit" },
    ]);

    // A tool off the list, or anything the call adds, is refused before the service.
    for (const body of [
      { ...call, tool: "read_file" },
      { ...call, tool: "mcp__conversation__read_thread" },
      { ...call, arguments: { channel: "C0OTHER" } },
      { ...call, thread_ts: "1700000000.000100" },
    ]) {
      expect((await errorOf(await read(body))).status).toBe(400);
    }
    expect(h.readCalls).toHaveLength(2);

    for (const [outcome, status, code] of [
      ["unknown_turn", 404, "NOT_FOUND"],
      ["not_holder", 403, "FORBIDDEN"],
      ["lease_expired", 409, "REQUEST_EXPIRED"],
    ] as const) {
      h.answerReads({ outcome });
      expect(await errorOf(await read(call))).toEqual({ status, code });
    }
  });

  test("the runtime's bearer is 403 on every session worker route and on any other internal path, before any credential lookup", async () => {
    const h = harness();
    for (const path of Object.keys(WORKER_PROTOCOL_ROUTES)) {
      for (const token of [CURRENT, PREVIOUS]) {
        expect({
          path,
          ...(await errorOf(await h.post(`/worker${path}`, token, {}))),
        }).toEqual({ path, status: 403, code: "FORBIDDEN" });
      }
    }
    for (const path of [
      "/conversation-runtime",
      "/conversation-runtime/turns",
      "/elsewhere",
    ]) {
      expect(await errorOf(await h.post(path, CURRENT, {}))).toEqual({
        status: 403,
        code: "FORBIDDEN",
      });
    }
    const extension = await h.post(
      "/worker/attempts/a/extensions/d",
      CURRENT,
      {},
    );
    expect(extension.status).toBe(403);
    // The worker gateway was never asked to resolve the runtime's bearer.
    expect(h.authenticated).toEqual([]);
    // A session worker's own credential still reaches its routes.
    expect((await h.post("/worker/heartbeat", WORKER, {})).status).not.toBe(
      403,
    );
    expect(h.authenticated).toEqual([WORKER]);
  });
});
