/// <reference lib="dom" />
import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiClientOptions,
  ApiError,
  createApiClient,
} from "@werft-ai/client";
import {
  agentSessionsQuery,
  pendingRequestsQuery,
  queryKeysOf,
  sessionQuery,
  sessionsQuery,
  sessionTurnsQuery,
  sessionUsageQuery,
  waitingSessionsQuery,
  withQueryScope,
} from "@werft-ai/core";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";
import {
  type SessionControl,
  useAnswer,
  useSendMessage,
  useSessionControl,
  useSessionEvents,
  WerftProvider,
} from "./index.ts";
import { eventToolCallId } from "./sessions.ts";

const { renderHook, waitFor, act } = await setupDom();

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";
const AT = "2026-10-11T08:14:02.000Z";
const BASE = `/v1/sessions/${SESSION_ID}`;

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const receipt = () =>
  json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" });

const serverError = () =>
  json(500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal error",
      retryable: true,
      request_id: "req-1",
      details: null,
    },
  });

/**
 * The session's event stream, held open: frames go out when the test
 * pushes them, and a closed stream would only replay them on reconnect.
 */
function eventStream() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = (signal: AbortSignal) => {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    signal.addEventListener("abort", () =>
      controller?.error(new DOMException("aborted", "AbortError")),
    );
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  let seq = 0;
  const frame = (event: string, data: unknown, id = `ev_${++seq}`) => {
    const envelope = {
      schema_version: 1,
      session_id: SESSION_ID,
      turn_id: "1",
      attempt_id: null,
      occurred_at: AT,
      data,
    };
    return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
  };
  /** Every frame in one write, as one read of a busy stream delivers them. */
  const push = (...frames: (readonly [event: string, data: unknown])[]) =>
    controller?.enqueue(
      encoder.encode(frames.map(([e, d]) => frame(e, d)).join("")),
    );
  /** One frame again under an id already sent, as a replay sends it. */
  const replay = (id: string, [event, data]: readonly [string, unknown]) =>
    controller?.enqueue(encoder.encode(frame(event, data, id)));
  return { response, push, replay };
}

function harness(
  answer: (sent: Sent) => Response,
  queryClient = new QueryClient(),
) {
  const sent: Sent[] = [];
  const stream = eventStream();
  const fakeFetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === `${BASE}/events`) return stream.response(request.signal);
    const text = await request.text();
    const entry = {
      method: request.method,
      path,
      idempotencyKey: request.headers.get("idempotency-key"),
      body: text ? JSON.parse(text) : undefined,
    };
    sent.push(entry);
    return answer(entry);
  };
  const client: ApiClient = withQueryScope(
    createApiClient({
      baseUrl: "https://console.test",
      fetch: fakeFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
    }),
    { actor: "user:u-1", workspace: "w-1" },
  );
  const seeded = { id: SESSION_ID, status: "running" };
  queryClient.setQueryData(
    sessionQuery(client, SESSION_ID).queryKey,
    seeded as never,
  );
  const invalidate = spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <WerftProvider
        client={client}
        locale="en"
        renderLink={() => null}
        eventRetry={{ initialMs: 1, maxMs: 4 }}
      >
        {children}
      </WerftProvider>
    </QueryClientProvider>
  );
  const keys = {
    list: sessionsQuery(client).queryKey,
    waiting: waitingSessionsQuery(client).queryKey,
    agentLists: queryKeysOf(client).agentSessionLists,
    detail: sessionQuery(client, SESSION_ID).queryKey,
    pending: pendingRequestsQuery(client, SESSION_ID).queryKey,
    usage: sessionUsageQuery(client, SESSION_ID).queryKey,
    turns: sessionTurnsQuery(client, SESSION_ID).queryKey,
    github: queryKeysOf(client).sessionGithubWork(SESSION_ID),
  };
  /** Each invalidation as the key it names and whether it matches exactly. */
  const invalidated = () =>
    invalidate.mock.calls.map(([filters]) => [
      filters?.queryKey,
      filters?.exact ?? false,
    ]);
  return {
    client,
    queryClient,
    seeded,
    sent,
    stream,
    wrapper,
    keys,
    invalidated,
  };
}

describe("useAnswer", () => {
  test("posts the answer with an idempotency key, then refreshes the detail and the pending list", async () => {
    const h = harness(receipt);
    const { result } = renderHook(() => useAnswer(SESSION_ID), {
      wrapper: h.wrapper,
    });
    const answer = {
      request_id: "req_1",
      kind: "permission",
      action: "deny",
      reason: "not on main",
    } as const;
    await act(() => result.current.mutateAsync(answer));
    expect(h.sent).toEqual([
      {
        method: "POST",
        path: `${BASE}/answers`,
        idempotencyKey: expect.any(String),
        body: answer,
      },
    ]);
    expect(h.invalidated()).toEqual([
      [h.keys.detail, true],
      [h.keys.pending, false],
    ]);
  });
});

describe("useSendMessage", () => {
  test("queues the message as the next turn", async () => {
    const h = harness(() =>
      json(202, {
        turn_id: "2",
        receipt_id: RECEIPT_ID,
        receipt_status: "accepted",
      }),
    );
    const { result } = renderHook(() => useSendMessage(SESSION_ID), {
      wrapper: h.wrapper,
    });
    const turn = await act(() =>
      result.current.mutateAsync({ message: "and the tests too" }),
    );
    expect(turn.turn_id).toBe("2");
    expect(h.sent).toEqual([
      {
        method: "POST",
        path: `${BASE}/messages`,
        idempotencyKey: expect.any(String),
        body: { message: "and the tests too", mode: "enqueue" },
      },
    ]);
    expect(h.invalidated()).toEqual([
      [h.keys.list, true],
      [h.keys.waiting, true],
      [h.keys.agentLists, false],
      [h.keys.detail, true],
      [h.keys.turns, false],
    ]);
  });
});

describe("useSessionControl", () => {
  test("sends each command to its own endpoint, each with a fresh idempotency key", async () => {
    const h = harness(receipt);
    const { result } = renderHook(() => useSessionControl(SESSION_ID), {
      wrapper: h.wrapper,
    });
    const commands: SessionControl[] = [
      { action: "interrupt", body: { target_turn_id: "1" } },
      { action: "pause", body: { expected_revision: 3, reason: "lunch" } },
      { action: "resume", body: { expected_revision: 4 } },
      { action: "terminate", body: { expected_revision: 5 } },
    ];
    for (const command of commands)
      await act(() => result.current.mutateAsync(command));
    expect(
      h.sent.map(({ method, path, body }) => [method, path, body]),
    ).toEqual(
      commands.map(({ action, body }) => ["POST", `${BASE}/${action}`, body]),
    );
    expect(new Set(h.sent.map((s) => s.idempotencyKey)).size).toBe(4);
    expect(h.invalidated().slice(0, 5)).toEqual([
      [h.keys.list, true],
      [h.keys.waiting, true],
      [h.keys.agentLists, false],
      [h.keys.detail, true],
      [h.keys.pending, false],
    ]);
  });
});

describe("a retried command", () => {
  test("sends its retry under the same idempotency key, the next call under a new one", async () => {
    let calls = 0;
    const h = harness(
      () => (++calls === 1 ? serverError() : receipt()),
      new QueryClient({
        defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
      }),
    );
    const { result } = renderHook(() => useSessionControl(SESSION_ID), {
      wrapper: h.wrapper,
    });
    const interrupt = {
      action: "interrupt",
      body: { target_turn_id: "1" },
    } as const;
    await act(() => result.current.mutateAsync(interrupt));
    await act(() => result.current.mutateAsync(interrupt));
    const [first, retry, next] = h.sent.map((s) => s.idempotencyKey);
    expect(h.sent).toHaveLength(3);
    expect(retry).toBe(first as string);
    expect(next).not.toBe(first as string);
  });

  test("overlapping calls with the same variables each keep their own key", async () => {
    // The first request under each key fails once, so every call retries.
    const seen = new Set<string | null>();
    const h = harness(
      ({ idempotencyKey }) => {
        if (seen.has(idempotencyKey)) return receipt();
        seen.add(idempotencyKey);
        return serverError();
      },
      new QueryClient({
        defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
      }),
    );
    const { result } = renderHook(() => useSessionControl(SESSION_ID), {
      wrapper: h.wrapper,
    });
    const interrupt = {
      action: "interrupt",
      body: { target_turn_id: "1" },
    } as const;
    await act(() =>
      Promise.all([
        result.current.mutateAsync(interrupt),
        result.current.mutateAsync(interrupt),
      ]),
    );
    const uses = new Map<string | null, number>();
    for (const { idempotencyKey } of h.sent)
      uses.set(idempotencyKey, (uses.get(idempotencyKey) ?? 0) + 1);
    expect([...uses.values()]).toEqual([2, 2]);
  });
});

describe("a refused command", () => {
  const cases: [string, (h: ReturnType<typeof harness>) => Promise<unknown>][] =
    [
      [
        "useAnswer",
        async (h) => {
          const { result } = renderHook(() => useAnswer(SESSION_ID), {
            wrapper: h.wrapper,
          });
          return act(() =>
            result.current.mutateAsync({
              request_id: "req_1",
              kind: "permission",
              action: "allow",
            }),
          );
        },
      ],
      [
        "useSendMessage",
        async (h) => {
          const { result } = renderHook(() => useSendMessage(SESSION_ID), {
            wrapper: h.wrapper,
          });
          return act(() => result.current.mutateAsync({ message: "hi" }));
        },
      ],
      [
        "useSessionControl",
        async (h) => {
          const { result } = renderHook(() => useSessionControl(SESSION_ID), {
            wrapper: h.wrapper,
          });
          return act(() =>
            result.current.mutateAsync({
              action: "interrupt",
              body: { target_turn_id: "1" },
            }),
          );
        },
      ],
    ];

  for (const [name, run] of cases) {
    test(`${name} hands the caller the error and leaves the cache alone`, async () => {
      const h = harness(serverError);
      const error = await run(h).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(500);
      expect((error as ApiError).code).toBe("INTERNAL_ERROR");
      expect(h.sent).toHaveLength(1);
      expect(h.invalidated()).toEqual([]);
      const detail = h.queryClient
        .getQueryCache()
        .find({ queryKey: h.keys.detail });
      expect(detail?.state.data).toBe(h.seeded);
      expect(detail?.state.isInvalidated).toBe(false);
    });
  }
});

describe("eventToolCallId", () => {
  test("a permission or question request carries the call it holds back", () => {
    for (const kind of ["permission", "question"] as const) {
      expect(
        eventToolCallId({
          event: "question",
          data: {
            request_id: "req_1",
            tool_use_id: "call_2",
            kind,
            input: {},
          },
        }),
      ).toBe("call_2");
    }
  });
});

describe("useSessionEvents", () => {
  const status = ["status", { phase: "running" }] as const;
  const assistant = [
    "assistant",
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "on it" }] },
    },
  ] as const;
  const toolUse = [
    "tool_use",
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "call_1", name: "Bash", input: {} }],
      },
    },
  ] as const;
  const toolResult = [
    "tool_result",
    { tool_use_id: "call_1", content: "ok" },
  ] as const;
  const question = [
    "question",
    {
      request_id: "req_1",
      tool_use_id: "call_2",
      kind: "permission",
      tool: "Bash",
      input: { command: "git push" },
    },
  ] as const;
  const result = [
    "result",
    { type: "result", subtype: "success", session_id: "engine-1" },
  ] as const;
  const error = ["error", { message: "engine crashed" }] as const;

  function open() {
    const h = harness(receipt);
    const hook = renderHook(() => useSessionEvents(SESSION_ID, true), {
      wrapper: h.wrapper,
    });
    return { h, hook };
  }

  test("a burst refreshes each query its events make stale, once", async () => {
    const { h, hook } = open();
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.push(status, assistant, question, status, result, error);
    });
    await waitFor(() => expect(hook.result.current.events).toHaveLength(6));
    await waitFor(() => expect(h.invalidated()).toHaveLength(8));
    expect(h.invalidated()).toEqual([
      [h.keys.list, true],
      [h.keys.waiting, true],
      [h.keys.agentLists, false],
      [h.keys.detail, true],
      [h.keys.pending, false],
      [h.keys.usage, false],
      [h.keys.turns, false],
      [h.keys.github, false],
    ]);
  });

  test("a status event marks the sidebar's waiting count stale at once", async () => {
    const { h, hook } = open();
    h.queryClient.setQueryData(h.keys.waiting, {
      items: [],
      next_cursor: null,
    });
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.push(status);
    });
    await waitFor(() =>
      expect(h.queryClient.getQueryState(h.keys.waiting)?.isInvalidated).toBe(
        true,
      ),
    );
  });

  test("a status event marks every agent's session list stale, and no session detail", async () => {
    const { h, hook } = open();
    const page = { items: [], next_cursor: null };
    const agentList = (agentId: string) =>
      agentSessionsQuery(h.client, agentId).queryKey;
    h.queryClient.setQueryData(agentList("agent-a"), page);
    h.queryClient.setQueryData(agentList("agent-b"), page);
    const other = sessionQuery(h.client, "other-session").queryKey;
    h.queryClient.setQueryData(other, { id: "other-session" } as never);
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.push(status);
    });
    await waitFor(() =>
      expect(
        ["agent-a", "agent-b"].map(
          (id) => h.queryClient.getQueryState(agentList(id))?.isInvalidated,
        ),
      ).toEqual([true, true]),
    );
    expect(h.queryClient.getQueryState(other)?.isInvalidated).toBe(false);
  });

  test("each event kind refreshes what it can change", async () => {
    const { h, hook } = open();
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    const expected = [
      [question, [h.keys.detail, h.keys.pending]],
      [result, [h.keys.detail, h.keys.usage, h.keys.github]],
      [error, [h.keys.detail]],
      [
        [
          "system",
          {
            type: "system",
            subtype: "workspace_limit_mode",
            bytes: "hard",
            inodes: "unknown",
            reason: "storage_declaration_and_capacity",
          },
        ],
        [h.keys.detail],
      ],
    ] as const;
    let seen = 0;
    for (const [event, keys] of expected) {
      act(() => {
        h.stream.push(event);
      });
      await waitFor(() =>
        expect(h.invalidated().length).toBe(seen + keys.length),
      );
      expect(
        h
          .invalidated()
          .slice(seen)
          .map(([key]) => key),
      ).toEqual([...keys]);
      seen += keys.length;
    }
  });

  test("a reconnect by hand keeps the events shown and adds a replayed one once", async () => {
    const { h, hook } = open();
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.push(status, assistant);
    });
    await waitFor(() => expect(hook.result.current.events).toHaveLength(2));
    act(() => hook.result.current.reconnect());
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.replay("ev_2", assistant);
      h.stream.push(result);
    });
    await waitFor(() => expect(hook.result.current.events).toHaveLength(3));
    expect(hook.result.current.events.map((e) => e.id)).toEqual([
      "ev_1",
      "ev_2",
      "ev_3",
    ]);
  });

  test("messages and tool calls refresh nothing", async () => {
    const { h, hook } = open();
    await waitFor(() => expect(hook.result.current.state).toBe("open"));
    act(() => {
      h.stream.push(assistant, toolUse, toolResult);
    });
    await waitFor(() => expect(hook.result.current.events).toHaveLength(3));
    // A question after them proves a flush would have run by now.
    act(() => {
      h.stream.push(question);
    });
    await waitFor(() => expect(h.invalidated()).toHaveLength(2));
    expect(h.invalidated().map(([key]) => key)).toEqual([
      h.keys.detail,
      h.keys.pending,
    ]);
  });
});
