import { describe, expect, spyOn, test } from "bun:test";
import { jittered } from "./events.ts";
import {
  type ApiError,
  type ContractMismatch,
  createApiClient,
  type SessionEventFrame,
  type StreamState,
  subscribeSessionEvents,
  type ValidateMode,
  type Validator,
} from "./index.ts";
import { createFrameParser } from "./sse.ts";

const SESSION = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const OTHER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const AT = "2026-10-11T08:14:02.000Z";

function frame(
  id: string,
  event: string,
  data: unknown,
  envelope: Record<string, unknown> = {},
): string {
  const body = {
    schema_version: 1,
    session_id: SESSION,
    turn_id: "1",
    attempt_id: null,
    occurred_at: AT,
    data,
    ...envelope,
  };
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

/**
 * The server's side of each connection, in order: a status to answer with,
 * or the text to stream. A stream ends after its text unless `hold` keeps it
 * open, as the real one does, until the client goes away.
 */
type Connection =
  | { status: number; headers?: Record<string, string>; body?: unknown }
  | { text: string; hold?: boolean };

function eventServer(script: Connection[]) {
  const requests: Request[] = [];
  const fetch = (async (request: Request) => {
    requests.push(request);
    const next = script.shift() ?? { text: "", hold: true };
    if ("status" in next) {
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { "content-type": "application/json", ...next.headers },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (next.text) controller.enqueue(new TextEncoder().encode(next.text));
        if (!next.hold) return controller.close();
        request.signal.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const FAST = { initialMs: 1, maxMs: 4, idleMs: 1_000 };

function subscribe(
  server: ReturnType<typeof eventServer>,
  options: {
    validate?: ValidateMode;
    sessionEvent?: Validator;
    lastEventId?: string;
    idleMs?: number;
    undecidedMs?: number;
  } = {},
) {
  const events: SessionEventFrame[] = [];
  const states: StreamState[] = [];
  const retries: number[] = [];
  const errors: ApiError[] = [];
  const mismatches: ContractMismatch[] = [];
  const client = createApiClient({
    baseUrl: "https://api.test",
    fetch: server.fetch,
    validate: options.validate ?? "off",
    validators: options.sessionEvent
      ? { sessionEvent: options.sessionEvent }
      : {},
    onContractMismatch: (mismatch) => mismatches.push(mismatch),
  });
  const stop = new AbortController();
  const done = subscribeSessionEvents(client, SESSION, {
    signal: stop.signal,
    ...(options.lastEventId ? { lastEventId: options.lastEventId } : {}),
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    onRetry: (failed) => retries.push(failed),
    retry: {
      ...FAST,
      ...(options.idleMs ? { idleMs: options.idleMs } : {}),
      ...(options.undecidedMs ? { undecidedMs: options.undecidedMs } : {}),
    },
  });
  return { events, states, errors, retries, mismatches, stop, done };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

const lastEventIds = (server: ReturnType<typeof eventServer>) =>
  server.requests.map((r) => r.headers.get("last-event-id"));

describe("subscribeSessionEvents", () => {
  test("delivers frames with their envelope unpacked, over the client's own headers", async () => {
    const server = eventServer([
      { text: frame("ev_1", "status", { phase: "running" }), hold: true },
    ]);
    const run = subscribe(server);
    await until(() => run.events.length === 1);
    expect(run.events[0]).toEqual({
      id: "ev_1",
      occurredAt: AT,
      turnId: "1",
      attemptId: null,
      payload: { event: "status", data: { phase: "running" } },
    } as SessionEventFrame);
    const [request] = server.requests;
    expect(new URL(request?.url ?? "").pathname).toBe(
      `/v1/sessions/${SESSION}/events`,
    );
    expect(request?.headers.get("x-requested-with")).toBe("werft-web");
    expect(request?.headers.get("accept")).toBe("text/event-stream");
    expect(request?.headers.get("last-event-id")).toBeNull();
    expect(run.states).toEqual(["connecting", "open"]);
    run.stop.abort();
    await run.done;
    expect(run.states.at(-1)).toBe("closed");
  });

  test("reconnects after a drop with Last-Event-ID, and delivers a repeated id once", async () => {
    const server = eventServer([
      {
        text:
          frame("ev_1", "status", { phase: "running" }) +
          frame("ev_2", "status", { phase: "idle" }),
      },
      { status: 503 },
      {
        text:
          frame("ev_2", "status", { phase: "idle" }) +
          frame("ev_3", "status", { phase: "running" }),
        hold: true,
      },
    ]);
    const run = subscribe(server);
    await until(() => run.events.length === 3);
    expect(run.events.map((e) => e.id)).toEqual(["ev_1", "ev_2", "ev_3"]);
    expect(lastEventIds(server)).toEqual([null, "ev_2", "ev_2"]);
    expect(run.errors).toEqual([]);
    run.stop.abort();
    await run.done;
  });

  test("an older frame replayed later does not move the cursor back", async () => {
    const server = eventServer([
      {
        text:
          frame("ev_1", "status", { phase: "running" }) +
          frame("ev_2", "status", { phase: "idle" }) +
          frame("ev_1", "status", { phase: "running" }),
      },
      { text: "", hold: true },
    ]);
    const run = subscribe(server);
    await until(() => server.requests.length === 2);
    expect(run.events.map((e) => e.id)).toEqual(["ev_1", "ev_2"]);
    expect(lastEventIds(server)).toEqual([null, "ev_2"]);
    run.stop.abort();
    await run.done;
  });

  test("an abort that lands before the wait ends it at once, not after Retry-After", async () => {
    const stop = new AbortController();
    const client = createApiClient({
      baseUrl: "https://api.test",
      fetch: (async () => {
        stop.abort();
        return new Response("{}", {
          status: 503,
          headers: { "retry-after": "30" },
        });
      }) as unknown as typeof fetch,
    });
    const started = Date.now();
    await subscribeSessionEvents(client, SESSION, {
      signal: stop.signal,
      onEvent: () => {},
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("starts after the caller's cursor", async () => {
    const server = eventServer([
      { text: frame("ev_8", "status", { phase: "idle" }), hold: true },
    ]);
    const run = subscribe(server, { lastEventId: "ev_7" });
    await until(() => run.events.length === 1);
    expect(lastEventIds(server)).toEqual(["ev_7"]);
    run.stop.abort();
    await run.done;
  });

  describe("a kind this client does not know", () => {
    const newKind = () =>
      eventServer([
        {
          text:
            frame("ev_1", "status", { phase: "running" }) +
            frame("ev_2", "telemetry", { cpu: 1 }) +
            frame("ev_3", "constructor", { cpu: 1 }),
        },
        { text: ": keepalive\n\n", hold: true },
      ]);

    test("is dropped without a word, and the cursor moves past it", async () => {
      for (const validate of ["warn", "off"] as const) {
        const server = newKind();
        const run = subscribe(server, { validate });
        await until(() => server.requests.length === 2);
        expect(run.events.map((e) => e.id)).toEqual(["ev_1"]);
        expect(lastEventIds(server)).toEqual([null, "ev_3"]);
        expect(run.errors).toEqual([]);
        expect(run.mismatches).toEqual([]);
        run.stop.abort();
        await run.done;
      }
    });

    test("an aborted subscription delivers nothing more, not even the rest of a chunk", async () => {
      const server = eventServer([
        {
          text:
            frame("ev_1", "status", { phase: "running" }) +
            frame("ev_2", "status", { phase: "idle" }),
          hold: true,
        },
      ]);
      const stop = new AbortController();
      const events: string[] = [];
      const client = createApiClient({
        baseUrl: "https://api.test",
        fetch: server.fetch,
      });
      await subscribeSessionEvents(client, SESSION, {
        signal: stop.signal,
        onEvent: (event) => {
          events.push(event.id);
          stop.abort();
        },
        retry: FAST,
      });
      expect(events).toEqual(["ev_1"]);
    });

    test("fails a strict client, which runs against today's contract", async () => {
      const run = subscribe(newKind(), { validate: "strict" });
      await run.done;
      expect(run.errors.map((e) => e.mismatch?.issues)).toEqual([
        [{ path: "event", message: "unknown kind" }],
      ]);
    });
  });

  test("a new envelope version is reported, dropped, and the cursor moves past it", async () => {
    const server = eventServer([
      {
        text: frame("ev_1", "status", { phase: "idle" }, { schema_version: 2 }),
      },
      { text: frame("ev_2", "status", { phase: "running" }), hold: true },
    ]);
    const run = subscribe(server, { validate: "warn" });
    await until(() => run.events.length === 1);
    expect(run.events.map((e) => e.id)).toEqual(["ev_2"]);
    expect(lastEventIds(server)).toEqual([null, "ev_1"]);
    expect(run.mismatches.map((m) => m.issues)).toEqual([
      [{ path: "data.schema_version", message: "not 1" }],
    ]);
    run.stop.abort();
    await run.done;
  });

  test("a frame without its own id is not delivered under the previous one", async () => {
    const server = eventServer([
      {
        text:
          frame("ev_1", "status", { phase: "running" }) +
          `event: status\ndata: ${JSON.stringify({ schema_version: 1, session_id: SESSION, turn_id: null, attempt_id: null, occurred_at: AT, data: { phase: "idle" } })}\n\n` +
          frame("ev_3", "status", { phase: "idle" }),
        hold: true,
      },
    ]);
    const run = subscribe(server, { validate: "warn" });
    await until(() => run.events.length === 2);
    expect(run.events.map((e) => e.id)).toEqual(["ev_1", "ev_3"]);
    expect(run.mismatches.map((m) => m.issues)).toEqual([
      [{ path: "id", message: "missing" }],
    ]);
    run.stop.abort();
    await run.done;
  });

  test("an id in another case is the same session", async () => {
    const server = eventServer([
      { text: frame("ev_1", "status", { phase: "running" }), hold: true },
    ]);
    const events: SessionEventFrame[] = [];
    const stop = new AbortController();
    const client = createApiClient({
      baseUrl: "https://api.test",
      fetch: server.fetch,
      validate: "strict",
    });
    const done = subscribeSessionEvents(client, SESSION.toUpperCase(), {
      signal: stop.signal,
      onEvent: (event) => events.push(event),
      retry: FAST,
    });
    await until(() => events.length === 1);
    stop.abort();
    await done;
  });

  test("a client from elsewhere is refused rather than left unchecked", async () => {
    const { default: createClient } = await import("openapi-fetch");
    const raw = createClient({}) as unknown as Parameters<
      typeof subscribeSessionEvents
    >[0];
    await expect(
      subscribeSessionEvents(raw, SESSION, {
        signal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow("createApiClient");
  });

  test("a silent connection is taken for dead and reopened", async () => {
    const server = eventServer([
      { text: frame("ev_1", "status", { phase: "running" }), hold: true },
      { text: "", hold: true },
    ]);
    const run = subscribe(server, { idleMs: 30 });
    await until(() => server.requests.length === 2);
    expect(lastEventIds(server)).toEqual([null, "ev_1"]);
    run.stop.abort();
    await run.done;
  });

  test("an abort while connecting opens nothing", async () => {
    const server = eventServer([]);
    const stop = new AbortController();
    const client = createApiClient({
      baseUrl: "https://api.test",
      fetch: server.fetch,
    });
    const states: StreamState[] = [];
    await subscribeSessionEvents(client, SESSION, {
      signal: stop.signal,
      onEvent: () => {},
      onState: (state) => {
        states.push(state);
        if (state === "connecting") stop.abort();
      },
      retry: { idleMs: 60_000 },
    });
    expect(server.requests).toHaveLength(0);
    expect(states).toEqual(["connecting", "closed"]);
  });

  test("a refusal ends the stream with the server's error", async () => {
    const server = eventServer([
      {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Session not found" } },
      },
    ]);
    const run = subscribe(server);
    await run.done;
    expect(run.errors.map((e) => [e.status, e.code, e.message])).toEqual([
      [404, "NOT_FOUND", "Session not found"],
    ]);
    expect(run.states).toEqual(["connecting", "closed"]);
    expect(server.requests).toHaveLength(1);
  });

  const undecided = {
    status: 403,
    body: {
      error: {
        code: "FORBIDDEN",
        message: "This principal does not hold session.read",
        details: { reason_code: "error" },
      },
    },
  };

  test("a refusal the policy could not decide is retried, counting the failed attempts", async () => {
    const server = eventServer([
      { text: frame("ev_1", "status", { phase: "running" }) },
      undecided,
      { status: 503 },
      undecided,
      { text: frame("ev_2", "status", { phase: "idle" }), hold: true },
    ]);
    const run = subscribe(server);
    await until(() => run.events.length === 2);
    expect(run.events.map((e) => e.id)).toEqual(["ev_1", "ev_2"]);
    expect(lastEventIds(server)).toEqual([
      null,
      "ev_1",
      "ev_1",
      "ev_1",
      "ev_1",
    ]);
    expect(run.retries).toEqual([0, 1, 2, 3]);
    expect(run.errors).toEqual([]);
    run.stop.abort();
    await run.done;
  });

  test("a refusal it could not decide ends the stream once it lasts past the limit", async () => {
    const server = eventServer(Array.from({ length: 500 }, () => undecided));
    const run = subscribe(server, { undecidedMs: 30 });
    await run.done;
    expect(run.errors.map((e) => [e.status, e.code])).toEqual([
      [403, "FORBIDDEN"],
    ]);
    expect(run.states.at(-1)).toBe("closed");
    expect(server.requests.length).toBeGreaterThan(1);
  });

  test("the limit holds the failures that follow an undecided refusal too", async () => {
    const server = eventServer([
      undecided,
      ...Array.from({ length: 500 }, () => ({ status: 503 })),
    ]);
    const run = subscribe(server, { undecidedMs: 30 });
    await run.done;
    expect(run.errors.map((e) => [e.status, e.code])).toEqual([
      [403, "FORBIDDEN"],
    ]);
    expect(run.states.at(-1)).toBe("closed");
    expect(server.requests.length).toBeGreaterThan(2);
  });

  for (const [status, code, details] of [
    [403, "FORBIDDEN", { reason_code: "role" }],
    [403, "FORBIDDEN", null],
    [401, "UNAUTHORIZED", null],
  ] as const) {
    test(`a ${status} with reason ${details?.reason_code ?? "none"} ends the stream at once`, async () => {
      const server = eventServer([
        {
          status,
          body: { error: { code, message: "refused", details } },
        },
      ]);
      const run = subscribe(server);
      await run.done;
      expect(run.errors.map((e) => [e.status, e.code])).toEqual([
        [status, code],
      ]);
      expect(server.requests).toHaveLength(1);
    });
  }

  test("each wait is drawn between half of the backoff and all of it", () => {
    const random = spyOn(Math, "random");
    try {
      random
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0.5)
        .mockReturnValueOnce(1);
      expect([jittered(800), jittered(800), jittered(800)]).toEqual([
        400, 600, 800,
      ]);
    } finally {
      random.mockRestore();
    }
  });

  describe("an envelope that breaks the contract", () => {
    const wrongSession = () =>
      eventServer([
        {
          text:
            frame(
              "ev_1",
              "status",
              { phase: "running" },
              { session_id: OTHER },
            ) + frame("ev_2", "status", { phase: "idle" }),
          hold: true,
        },
      ]);

    test("strict ends the stream with CLIENT_CONTRACT_MISMATCH", async () => {
      const run = subscribe(wrongSession(), { validate: "strict" });
      await run.done;
      expect(run.events).toEqual([]);
      expect(run.errors.map((e) => [e.code, e.mismatch])).toEqual([
        [
          "CLIENT_CONTRACT_MISMATCH",
          {
            operation: "SSE /v1/sessions/{id}/events",
            issues: [
              {
                path: "data.session_id",
                message: "not the subscribed session",
              },
            ],
          },
        ],
      ]);
    });

    test("warn reports it, drops the frame and goes on", async () => {
      const run = subscribe(wrongSession(), { validate: "warn" });
      await until(() => run.events.length === 1);
      expect(run.events.map((e) => e.id)).toEqual(["ev_2"]);
      expect(run.mismatches).toHaveLength(1);
      run.stop.abort();
      await run.done;
    });

    test("off drops it silently", async () => {
      const run = subscribe(wrongSession(), { validate: "off" });
      await until(() => run.events.length === 1);
      expect(run.events.map((e) => e.id)).toEqual(["ev_2"]);
      expect(run.mismatches).toEqual([]);
      run.stop.abort();
      await run.done;
    });
  });

  test("a full frame validator follows the mode", async () => {
    const phaseIsKnown: Validator = (value) => {
      const { data } = value as { data: { data: { phase?: string } } };
      return data.data.phase === "warp"
        ? [{ path: "data.data.phase", message: "Invalid option" }]
        : [];
    };
    const text = frame("ev_1", "status", { phase: "warp" });
    const strict = subscribe(eventServer([{ text, hold: true }]), {
      validate: "strict",
      sessionEvent: phaseIsKnown,
    });
    await strict.done;
    expect(strict.errors.map((e) => e.code)).toEqual([
      "CLIENT_CONTRACT_MISMATCH",
    ]);
    expect(strict.events).toEqual([]);

    const warn = subscribe(eventServer([{ text, hold: true }]), {
      validate: "warn",
      sessionEvent: phaseIsKnown,
    });
    await until(() => warn.events.length === 1);
    expect(warn.mismatches).toHaveLength(1);
    warn.stop.abort();
    await warn.done;
  });
});

describe("frame parser", () => {
  test("reads frames split anywhere, CRLF or LF, skipping comments", () => {
    const parser = createFrameParser();
    const text =
      ': keepalive\r\n\r\nid: ev_1\r\nevent: status\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid:ev_2\nevent:error\ndata:x\n\n';
    const frames = [];
    for (const piece of text.split("")) frames.push(...parser.push(piece));
    expect(frames).toEqual([
      { id: "ev_1", event: "status", data: '{"a":\n1}' },
      { id: "ev_2", event: "error", data: "x" },
    ]);
  });
});
