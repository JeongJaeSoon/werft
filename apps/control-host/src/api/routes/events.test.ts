import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  SSE_SCHEMA_VERSION,
  type SseEvent,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
  InvalidCursorError,
  type ReadEventsQuery,
  type SessionControl,
  type SessionReader,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import type { SessionEventWakeup } from "../session-notifier.ts";
import { registerEventRoutes } from "./sessions/events.ts";

const createApiApp = recordRouteErrors("routes/events.test.ts");

// SSE never reaches a control transaction.
const unusedControls: SessionControl = {
  terminateAtomic: async () => {
    throw new Error("not reached");
  },
  pauseAtomic: async () => {
    throw new Error("not reached");
  },
  closeAtomic: async () => {
    throw new Error("not reached");
  },
  decideRecoveryAtomic: async () => {
    throw new Error("not reached");
  },
  resumeAtomic: async () => {
    throw new Error("not reached");
  },
  renameAtomic: async () => {
    throw new Error("not reached");
  },
};

const SESSION = "019a0000-0000-7000-8000-000000000001";
const OWNER = "owner-a";
const KEY = {
  id: "key-a",
  ownerId: OWNER,
  workspaceId: null,
  kind: "operator" as const,
  createdByUserId: null,
  creatorRole: null,
  scopes: ["sessions:read" as const],
};

function event(id: number, phase = "running"): SseEvent {
  return {
    id: `ev_${id.toString(36)}`,
    event: "status",
    data: {
      schema_version: SSE_SCHEMA_VERSION,
      session_id: SESSION,
      turn_id: "1",
      attempt_id: "a1",
      occurred_at: "2026-09-23T00:00:00.000Z",
      data: { phase },
    },
  } as SseEvent;
}

// An in-memory events table: readEvents pages by id like the Postgres reader.
class FakeStore {
  events: SseEvent[] = [];
  reads: ReadEventsQuery[] = [];
  owner = OWNER;
  // Runs after a page is computed and before it is returned: a commit that
  // lands while the read is in flight.
  onRead: ((query: ReadEventsQuery) => void) | undefined;

  append(...items: SseEvent[]) {
    this.events.push(...items);
  }

  reader(): SessionReader["readEvents"] {
    return async (ownerId, sessionId, query) => {
      this.reads.push(query);
      if (ownerId !== this.owner || sessionId !== SESSION) return null;
      if (query.after !== undefined && !/^ev_[0-9a-z]+$/.test(query.after)) {
        throw new InvalidCursorError();
      }
      const afterId = query.after
        ? Number.parseInt(query.after.slice(3), 36)
        : 0;
      const rest = this.events.filter(
        (item) => Number.parseInt(item.id.slice(3), 36) > afterId,
      );
      const fetched = rest.slice(0, query.limit);
      // Same cut as the Postgres reader: first row always, then a running
      // byte total against maxBytes.
      const items: SseEvent[] = [];
      let bytes = 0;
      for (const item of fetched) {
        bytes += JSON.stringify(item.data.data).length;
        if (items.length > 0 && bytes > query.maxBytes) break;
        items.push(item);
      }
      this.onRead?.(query);
      return {
        items,
        more: fetched.length === query.limit || items.length < fetched.length,
      };
    };
  }
}

class FakeWakeup implements SessionEventWakeup {
  waiters: Array<{ sessionId: string; resolve: () => void }> = [];

  wait(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { sessionId, resolve };
      this.waiters.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((item) => item !== entry);
          resolve();
        },
        { once: true },
      );
    });
  }

  async armed(): Promise<void> {
    for (let i = 0; i < 50 && this.waiters.length === 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(this.waiters.length).toBeGreaterThan(0);
  }

  notify(sessionId = SESSION) {
    const due = this.waiters.filter((item) => item.sessionId === sessionId);
    this.waiters = this.waiters.filter((item) => item.sessionId !== sessionId);
    for (const item of due) item.resolve();
  }
}

function harness(
  options: {
    keepaliveMs?: number;
    batchSize?: number;
    batchMaxBytes?: number;
    maxStreams?: number;
    maxStreamsPerOwner?: number;
  } = {},
) {
  const store = new FakeStore();
  const wakeup = new FakeWakeup();
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization: createAuthorizationPolicy(),
    controls: unusedControls,
    catalog: { connections: {}, repositories: {} },
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      countSessions: async () => {
        throw new Error("not reached");
      },
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt: async () => null,
      hiddenAgentRefs: async () => ({
        agentIds: new Set<string>(),
        releaseIds: new Set<string>(),
      }),
      readEvents: store.reader(),
    },
  });
  let handle: ReturnType<typeof registerEventRoutes> | undefined;
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => {
      handle = registerEventRoutes(router, service, {
        wakeup,
        logger: { info() {}, warn() {} },
        ...options,
      });
    },
  });
  if (!handle) throw new Error("routes not registered");
  return { app, store, wakeup, handle };
}

type Frame = { id?: string; event?: string; data?: string; comment?: string };

// Reads SSE frames off the body as they arrive; a frame ends at a blank line.
class FrameReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  #frames: Frame[] = [];
  #done = false;

  constructor(response: Response) {
    if (!response.body) throw new Error("no body");
    this.#reader = response.body.getReader();
  }

  async next(timeoutMs = 2_000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.#frames.length === 0 && !this.#done) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a frame");
      const chunk = await Promise.race([
        this.#reader.read(),
        Bun.sleep(remaining).then(() => ({ done: false, value: undefined })),
      ]);
      if (chunk.done) {
        this.#done = true;
        break;
      }
      if (!chunk.value) continue;
      this.#buffer += new TextDecoder().decode(chunk.value);
      let end = this.#buffer.indexOf("\n\n");
      while (end !== -1) {
        this.#frames.push(parseFrame(this.#buffer.slice(0, end)));
        this.#buffer = this.#buffer.slice(end + 2);
        end = this.#buffer.indexOf("\n\n");
      }
    }
    return this.#frames.shift() ?? null;
  }

  async ended(timeoutMs = 2_000): Promise<boolean> {
    const frame = await this.next(timeoutMs);
    return frame === null && this.#done;
  }

  cancel() {
    return this.#reader.cancel();
  }
}

function parseFrame(raw: string): Frame {
  const frame: Frame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
    } else {
      const separator = line.indexOf(":");
      const field = line.slice(0, separator);
      const value = line.slice(separator + 1).trimStart();
      if (field === "id" || field === "event" || field === "data") {
        frame[field] = value;
      }
    }
  }
  return frame;
}

function open(
  app: ReturnType<typeof createApiApp>,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) {
  return app.request(`/v1/sessions/${SESSION}/events`, {
    headers: { "X-Owner-Id": OWNER, ...headers },
    ...init,
  });
}

describe("GET /v1/sessions/{id}/events", () => {
  test("replays from the beginning as text/event-stream frames", async () => {
    const { app, store } = harness();
    store.append(event(1, "queued"), event(2, "running"));
    const response = await open(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const frames = new FrameReader(response);
    const first = await frames.next();
    expect(first).toEqual({
      id: "ev_1",
      event: "status",
      data: JSON.stringify(event(1, "queued").data),
    });
    const second = await frames.next();
    expect(second?.id).toBe("ev_2");
    expect(JSON.parse(second?.data ?? "{}").data).toEqual({
      phase: "running",
    });
    expect(store.reads[0]).toEqual({ limit: 100, maxBytes: 1024 * 1024 });
    await frames.cancel();
  });

  test("resumes after Last-Event-ID and pages through the backlog", async () => {
    const { app, store } = harness({ batchSize: 2 });
    store.append(event(1), event(2), event(3), event(4), event(5));
    const response = await open(app, { "Last-Event-ID": "ev_1" });
    const frames = new FrameReader(response);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await frames.next())?.id ?? "");
    expect(ids).toEqual(["ev_2", "ev_3", "ev_4", "ev_5"]);
    for (let i = 0; i < 50 && store.reads.length < 3; i += 1) {
      await Bun.sleep(5);
    }
    // Three pages: after ev_1, after ev_3 (full), after ev_5 (short, then wait).
    expect(store.reads.map((read) => read.after)).toEqual([
      "ev_1",
      "ev_3",
      "ev_5",
    ]);
    await frames.cancel();
  });

  test("a page cut by the byte bound keeps replaying instead of waiting", async () => {
    const big = (id: number) =>
      ({
        ...event(id),
        data: { ...event(id).data, data: { phase: "x".repeat(400) } },
      }) as SseEvent;
    const { app, store, wakeup } = harness({
      batchSize: 10,
      batchMaxBytes: 1_000,
    });
    // 5 events of ~410 bytes: pages of 2, never a full row-limit page.
    store.append(big(1), big(2), big(3), big(4), big(5));
    const response = await open(app);
    const frames = new FrameReader(response);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await frames.next())?.id ?? "");
    expect(ids).toEqual(["ev_1", "ev_2", "ev_3", "ev_4", "ev_5"]);
    await wakeup.armed();
    expect(store.reads.map((read) => read.after)).toEqual([
      undefined,
      "ev_2",
      "ev_4",
    ]);
    await frames.cancel();
  });

  test("an uppercase session id still wakes on the lowercase NOTIFY", async () => {
    const { app, store, wakeup } = harness();
    store.append(event(1));
    const response = await app.request(
      `/v1/sessions/${SESSION.toUpperCase()}/events`,
      { headers: { "X-Owner-Id": OWNER } },
    );
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await wakeup.armed();
    expect(wakeup.waiters[0]?.sessionId).toBe(SESSION);
    store.append(event(2));
    wakeup.notify(SESSION);
    expect((await frames.next())?.id).toBe("ev_2");
    await frames.cancel();
  });

  test("a NOTIFY that lands during a read is not lost", async () => {
    const { app, store, wakeup } = harness({ keepaliveMs: 5_000 });
    store.append(event(1));
    // The commit fires while the caught-up read is in flight: the waiter
    // must already exist, or the stream idles until the keepalive.
    store.onRead = (query) => {
      if (query.after === "ev_1" && store.events.length === 1) {
        store.append(event(2));
        expect(wakeup.waiters).toHaveLength(1);
        wakeup.notify();
      }
    };
    const response = await open(app);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await wakeup.armed();
    wakeup.notify();
    // Read after ev_1 returns a short page, but the mid-read notify already
    // resolved the armed waiter, so ev_2 arrives well before the keepalive.
    expect((await frames.next(1_000))?.id).toBe("ev_2");
    await frames.cancel();
  });

  test("a share narrowed while a page is in flight stops the page", async () => {
    const { app, store, wakeup } = harness({ keepaliveMs: 5_000 });
    store.append(event(1), event(2), event(3));
    // The narrowing commits while the first page is being read: from then on
    // the session is out of this caller's sight.
    store.onRead = (query) => {
      if (query.after === undefined) {
        wakeup.notify();
        store.owner = "someone-else";
      }
    };
    const response = await open(app);
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect(await frames.ended()).toBe(true);
  });

  test("a revoked credential ends a stream that is still replaying", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    // Every page is full: the backlog never drains, so the only chance to
    // notice the revocation is the clock check during replay.
    for (let i = 1; i <= 5_000; i += 1) store.append(event(i));
    let valid = true;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: async (ownerId, sessionId, query) => {
          await Bun.sleep(2);
          return store.reader()(ownerId, sessionId, query);
        },
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return valid ? KEY : null;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 20,
          batchSize: 10,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    valid = false;
    let received = 1;
    for (;;) {
      const frame = await frames.next();
      if (frame === null) break;
      received += 1;
    }
    expect(received).toBeLessThan(5_000);
    expect(await frames.ended()).toBe(true);
  });

  test("switches to live on NOTIFY without skipping or repeating", async () => {
    const { app, store, wakeup } = harness();
    store.append(event(1));
    const response = await open(app);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");

    await wakeup.armed();
    store.append(event(2), event(3));
    wakeup.notify();
    expect((await frames.next())?.id).toBe("ev_2");
    expect((await frames.next())?.id).toBe("ev_3");
    // A NOTIFY for another session does not wake this stream.
    await wakeup.armed();
    const reads = store.reads.length;
    wakeup.notify("019a0000-0000-7000-8000-00000000ffff");
    await Bun.sleep(20);
    expect(store.reads).toHaveLength(reads);
    expect(wakeup.waiters).toHaveLength(1);
    // Its own NOTIFY re-reads from the last id sent.
    wakeup.notify();
    for (let i = 0; i < 50 && store.reads.length === reads; i += 1) {
      await Bun.sleep(5);
    }
    expect(store.reads.at(-1)?.after).toBe("ev_3");
    await frames.cancel();
  });

  test("sends a keepalive comment on the clock while idle", async () => {
    const { app } = harness({ keepaliveMs: 40 });
    const response = await open(app);
    const frames = new FrameReader(response);
    const started = Date.now();
    expect((await frames.next())?.comment).toBe("keepalive");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect((await frames.next())?.comment).toBe("keepalive");
    await frames.cancel();
  });

  test("ends the stream once the credential no longer authenticates", async () => {
    const { store, wakeup } = harness();
    let valid = true;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: store.reader(),
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return valid ? KEY : null;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 30,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.comment).toBe("keepalive");
    valid = false;
    // The next tick re-checks the key and closes; nothing else is written.
    expect(await frames.ended()).toBe(true);
  });

  test("ends the stream once the key no longer holds sessions:read", async () => {
    const { store, wakeup } = harness();
    let scopes: Array<"sessions:read" | "sessions:write"> = ["sessions:read"];
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: store.reader(),
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return { ...KEY, scopes };
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 30,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.comment).toBe("keepalive");
    scopes = ["sessions:write"];
    // Still the same live key, but no longer one that may read.
    expect(await frames.ended()).toBe(true);
  });

  test("a revoked credential ends a stream whose writes are blocked", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    for (let i = 1; i <= 300; i += 1) store.append(event(i));
    let valid = true;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: store.reader(),
      },
    });
    let handle: ReturnType<typeof registerEventRoutes> | undefined;
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return valid ? KEY : null;
        },
      },
      registerRoutes: (router) => {
        handle = registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 50,
          logger: { info() {}, warn() {} },
        });
      },
    });
    // Nobody reads the body: backpressure blocks the writes mid-page.
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(200);
    await Bun.sleep(30);
    expect(handle?.activeStreams()).toBe(1);
    valid = false;
    for (let i = 0; i < 100 && handle?.activeStreams() !== 0; i += 1) {
      await Bun.sleep(10);
    }
    // Two keepalives at most: one for the stalled write, one for the check.
    expect(handle?.activeStreams()).toBe(0);
    await response.body?.cancel().catch(() => {});
  });

  test("a key revoked while the initial read is blocked gets 401, not a stream", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    store.append(event(1), event(2));
    let valid = true;
    let releaseRead: (() => void) | undefined;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: async (ownerId, sessionId, query) => {
          if (query.after === undefined) {
            // The first page waits on "the pool" longer than a keepalive.
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          }
          return store.reader()(ownerId, sessionId, query);
        },
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return valid ? KEY : null;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 20,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const pending = open(app, { Authorization: "Bearer csp_test" });
    for (let i = 0; i < 100 && !releaseRead; i += 1) await Bun.sleep(5);
    valid = false;
    // Past one keepalive the watchdog has seen the revocation even though
    // the read is still pending; releasing it afterwards must not stream.
    await Bun.sleep(60);
    releaseRead?.();
    // The watchdog fired while the read was blocked, so the response never
    // becomes a stream: it is the same 401 the middleware would have sent.
    const response = await pending;
    expect(response.status).toBe(401);
  });

  test("a revoked key closes a stream whose read never returns", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    store.append(event(1));
    let valid = true;
    let releaseRead: (() => void) | undefined;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: async (ownerId, sessionId, query) => {
          if (query.after === "ev_1") {
            // The live read hangs on "the pool" past the revocation window.
            await new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
          }
          return store.reader()(ownerId, sessionId, query);
        },
      },
    });
    let handle: ReturnType<typeof registerEventRoutes> | undefined;
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          return valid ? KEY : null;
        },
      },
      registerRoutes: (router) => {
        handle = registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 40,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await wakeup.armed();
    wakeup.notify();
    for (let i = 0; i < 100 && !releaseRead; i += 1) await Bun.sleep(5);
    valid = false;
    const revokedAt = Date.now();
    // The body ends while the read is still pending: the watchdog closed it.
    expect(await frames.ended(1_000)).toBe(true);
    expect(Date.now() - revokedAt).toBeLessThan(200);
    expect(handle?.activeStreams()).toBe(1);
    releaseRead?.();
    for (let i = 0; i < 100 && handle?.activeStreams() !== 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(handle?.activeStreams()).toBe(0);
  });

  test("a stalled re-verification cannot stretch the revocation window", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    store.append(event(1));
    // The middleware's lookup answers; every later lookup hangs, as a slow
    // key store would after a revocation. The stream must still end within
    // one keepalive of the last check that answered.
    let lookups = 0;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        readEvents: store.reader(),
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        find() {
          lookups += 1;
          return lookups === 1 ? Promise.resolve(KEY) : new Promise(() => {});
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 100,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const openedAt = Date.now();
    const response = await open(app, { Authorization: "Bearer csp_test" });
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    // Live events keep arriving; none may be written past the expiry.
    const feeder = setInterval(() => {
      store.append(event(store.events.length + 1));
      wakeup.notify();
    }, 10);
    let last: Frame | null = null;
    let lastAt = openedAt;
    for (;;) {
      const frame = await frames.next(1_000);
      if (frame === null) break;
      last = frame;
      lastAt = Date.now();
    }
    clearInterval(feeder);
    expect(last?.id).not.toBeNull();
    expect(lastAt - openedAt).toBeLessThan(100 + 30);
    // The frame cut-off above is the contract; the close itself only has to
    // follow, and under a loaded test runner it can trail by a few ticks.
    expect(Date.now() - openedAt).toBeLessThan(500);
    expect(lookups).toBe(2);
  });

  test("a watchdog timer starved past expiry does not close a valid stream", async () => {
    const { app, store, wakeup } = harness({ keepaliveMs: 100 });
    store.append(event(1));
    const response = await open(app);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await wakeup.armed();
    // Block the event loop for three keepalives: the half-interval check
    // fires late, after `verifiedUntil`. The key is still valid, so the
    // late check must refresh the window rather than count as a revocation.
    const until = Date.now() + 300;
    while (Date.now() < until) {
      /* busy */
    }
    store.append(event(2));
    wakeup.notify();
    expect((await frames.next())?.id).toBe("ev_2");
    await frames.cancel();
  });

  test("a first read that fails while a check is in flight does not leave the watchdog running", async () => {
    const wakeup = new FakeWakeup();
    let lookups = 0;
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      controls: unusedControls,
      catalog: { connections: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        hiddenAgentRefs: async () => ({
          agentIds: new Set<string>(),
          releaseIds: new Set<string>(),
        }),
        // The first read fails at 70 ms: after the half-interval check has
        // started (50 ms) and before it answers (90 ms).
        readEvents: async () => {
          await Bun.sleep(70);
          throw new Error("database gone");
        },
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async find() {
          lookups += 1;
          if (lookups > 1) await Bun.sleep(40);
          return KEY;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 100,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(500);
    await Bun.sleep(400);
    // Middleware plus the one check already in flight; a re-armed watchdog
    // would have added several more by now.
    expect(lookups).toBe(2);
  });

  test("admission caps per owner and per process answer 429 before any read", async () => {
    const { app, store, handle } = harness({
      maxStreams: 3,
      maxStreamsPerOwner: 2,
    });
    store.append(event(1));
    const controllers: AbortController[] = [];
    const openFor = async (owner: string) => {
      const controller = new AbortController();
      controllers.push(controller);
      return open(app, { "X-Owner-Id": owner }, { signal: controller.signal });
    };
    expect((await openFor(OWNER)).status).toBe(200);
    expect((await openFor(OWNER)).status).toBe(200);
    const reads = store.reads.length;
    const third = await openFor(OWNER);
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBe("15");
    expect(apiErrorResponseSchema.parse(await third.json()).error.code).toBe(
      "RATE_LIMITED",
    );
    expect(store.reads).toHaveLength(reads);
    // Another owner still gets the last process-wide slot, then nothing.
    store.owner = "owner-b";
    expect((await openFor("owner-b")).status).toBe(200);
    expect((await openFor("owner-b")).status).toBe(429);
    expect(handle.activeStreams()).toBe(3);
    for (const controller of controllers) controller.abort();
    for (let i = 0; i < 100 && handle.activeStreams() > 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(handle.activeStreams()).toBe(0);
  });

  test("a blocked keepalive write closes the stream within the bound", async () => {
    const { app, handle } = harness({ keepaliveMs: 40 });
    // No events and nobody reads the body: the first keepalive write blocks.
    const response = await open(app);
    expect(response.status).toBe(200);
    await Bun.sleep(20);
    expect(handle.activeStreams()).toBe(1);
    for (let i = 0; i < 100 && handle.activeStreams() !== 0; i += 1) {
      await Bun.sleep(10);
    }
    expect(handle.activeStreams()).toBe(0);
    await response.body?.cancel().catch(() => {});
  });

  test("releases its handle when the client disconnects", async () => {
    const { app, wakeup, handle } = harness();
    const controller = new AbortController();
    const response = await open(app, {}, { signal: controller.signal });
    const frames = new FrameReader(response);
    await wakeup.armed();
    expect(handle.activeStreams()).toBe(1);
    controller.abort();
    for (let i = 0; i < 100 && handle.activeStreams() > 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(handle.activeStreams()).toBe(0);
    expect(wakeup.waiters).toHaveLength(0);
    await frames.cancel().catch(() => {});
  });

  test("answers 404 for a session of another owner", async () => {
    const { app, store } = harness();
    store.append(event(1));
    const response = await open(app, { "X-Owner-Id": "owner-b" });
    expect(response.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "NOT_FOUND",
    );
  });

  test("answers 400 for a malformed cursor before streaming", async () => {
    const { app } = harness();
    const response = await open(app, { "Last-Event-ID": "not-a-cursor" });
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "BAD_REQUEST",
    );
  });

  test("treats an empty Last-Event-ID as absent", async () => {
    const { app, store } = harness();
    store.append(event(1));
    const response = await open(app, { "Last-Event-ID": "" });
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await frames.cancel();
  });
});
