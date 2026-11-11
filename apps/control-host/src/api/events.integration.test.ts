import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createSessionResponseSchema,
  SESSION_SCOPE_VALUES,
  SSE_SCHEMA_VERSION,
  sseEventSchema,
  UNREADABLE_EVENT_CODE,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  apiKeys,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  encodeEventCursor,
  eventPageQuery,
  events,
  idempotencyKeys,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createSessionService,
  withSeededInstallation,
} from "@werft-ai/platform";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import { DatabaseApiKeyStore, issueApiKey } from "./keys.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

type Frame = { id?: string; event?: string; data?: string; comment?: string };

function parseFrames(text: string): Frame[] {
  return text
    .split("\n\n")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const frame: Frame = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) {
          frame.comment = line.slice(1).trim();
          continue;
        }
        const at = line.indexOf(":");
        const field = line.slice(0, at);
        if (field === "id" || field === "event" || field === "data") {
          frame[field] = line.slice(at + 1).trimStart();
        }
      }
      return frame;
    });
}

// Collects frames until `until` is satisfied or the stream ends.
async function collect(
  response: Response,
  until: (frames: Frame[]) => boolean,
  timeoutMs = 10_000,
): Promise<{ frames: Frame[]; ended: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  let text = "";
  let ended = false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = parseFrames(text);
    if (until(frames)) {
      await reader.cancel();
      return { frames, ended };
    }
    if (ended) return { frames, ended };
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out; got ${frames.length}`);
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: false, value: undefined })),
    ]);
    if (chunk.done) ended = true;
    else if (chunk.value) text += new TextDecoder().decode(chunk.value);
  }
}

integration("GET /v1/sessions/{id}/events on PostgreSQL", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let notifier: PostgresSessionNotifier;
  let app: ReturnType<typeof createApiApp>;
  let apiKeyApp: ReturnType<typeof createApiApp>;
  let handle: ReturnType<typeof registerEventRoutes>;
  const sink = new MemoryLogSink();
  const owner = `owner-${crypto.randomUUID()}`;
  const stranger = `owner-${crypto.randomUUID()}`;
  const KEEPALIVE_MS = 300;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    db = drizzle(pool, { schema });
    const state = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (state.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
    }
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: createAuthorizationPolicy(),
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db, {
        logger: createLogger({ sinks: [sink] }),
      }),
      catalog: withSeededInstallation({
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
            permission_mode: "default",
            provider: {
              kind: "litellm",
              endpoint: "https://litellm.invalid",
              auth: {
                kind: "api_key",
                ref: { value_env: "PROVIDER_KEY" },
              },
            },
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1"],
          },
        },
      }),
    });
    notifier = new PostgresSessionNotifier(
      databaseUrl ?? "",
      createLogger({ sinks: [sink] }),
    );
    await notifier.start();
    expect(notifier.listening).toBe(true);
    const logger = createLogger({ sinks: [sink] });
    app = createApiApp({
      authMode: "none",
      logger,
      registerRoutes: (router) => {
        registerSessionRoutes(router, service);
        handle = registerEventRoutes(router, service, {
          wakeup: notifier,
          keepaliveMs: KEEPALIVE_MS,
          logger,
        });
      },
    });
    apiKeyApp = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      registerRoutes: (router) => {
        registerSessionRoutes(router, service);
        registerEventRoutes(router, service, {
          wakeup: notifier,
          keepaliveMs: KEEPALIVE_MS,
          logger,
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await notifier.close();
    for (const ownerId of [owner, stranger]) {
      const owned = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.ownerId, ownerId));
      for (const { id } of owned) {
        await db.delete(events).where(eq(events.sessionId, id));
        await db.delete(queueMessages).where(eq(queueMessages.sessionId, id));
        await db
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, id));
        await db.delete(turns).where(eq(turns.sessionId, id));
      }
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.principal, ownerId));
      await db.delete(receipts).where(eq(receipts.ownerId, ownerId));
      await db.delete(sessions).where(eq(sessions.ownerId, ownerId));
      await db.delete(apiKeys).where(eq(apiKeys.ownerId, ownerId));
    }
    await pool.end();
  }, 60_000);

  async function createdSession(ownerId = owner): Promise<string> {
    const response = await app.request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": ownerId,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Inspect the failing unit test and propose a fix.",
      }),
    });
    expect(response.status).toBe(201);
    return createSessionResponseSchema.parse(await response.json()).session_id;
  }

  // What the worker gateway does per appendEvents: insert under the session
  // row lock and NOTIFY inside the same transaction.
  async function appendLikeWorker(sessionId: string, count: number) {
    await db.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      expect(session).toBeDefined();
      const [turn] = await tx
        .select({ id: turns.id })
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
      await tx.insert(events).values(
        Array.from({ length: count }, (_, i) => ({
          sessionId,
          type: "status",
          payload: { phase: "running", n: i },
          turnId: turn?.id ?? null,
          attemptId: "a1",
          occurredAt: new Date(),
        })),
      );
      await tx.execute(sql`SELECT pg_notify('session_events', ${sessionId})`);
    });
  }

  function stream(
    sessionId: string,
    headers: Record<string, string> = {},
    target = app,
    init: RequestInit = {},
  ) {
    return target.request(`/v1/sessions/${sessionId}/events`, {
      headers: { "X-Owner-Id": owner, ...headers },
      ...init,
    });
  }

  test("replays 1,000 events from the beginning and from a cursor halfway", async () => {
    const sessionId = await createdSession();
    for (let i = 0; i < 10; i += 1) await appendLikeWorker(sessionId, 100);

    const full = await stream(sessionId);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("text/event-stream");
    const all = await collect(
      full,
      (frames) => frames.filter((f) => f.id).length >= 1_000,
    );
    const ids = all.frames.filter((f) => f.id).map((f) => f.id as string);
    expect(ids).toHaveLength(1_000);
    for (const frame of all.frames.filter((f) => f.id)) {
      const parsed = sseEventSchema.parse({
        id: frame.id,
        event: frame.event,
        data: JSON.parse(frame.data ?? "null"),
      });
      expect(parsed.data.schema_version).toBe(SSE_SCHEMA_VERSION);
      expect(parsed.data.session_id).toBe(sessionId);
      expect(parsed.data.turn_id).toBe("1");
      expect(parsed.data.attempt_id).toBe("a1");
    }

    const half = ids[499];
    const resumed = await stream(sessionId, { "Last-Event-ID": half ?? "" });
    const rest = await collect(resumed, (frames) =>
      frames.some((f) => f.id === ids[999]),
    );
    const restIds = rest.frames.filter((f) => f.id).map((f) => f.id);
    expect(restIds).toHaveLength(500);
    expect(restIds).toEqual(ids.slice(500));
  }, 30_000);

  test("a stored row the contract rejects reads as EVENT_UNREADABLE under its own id, and the stream goes on past it", async () => {
    const sessionId = await createdSession();
    // The shape pause wrote before: a status event with no phase.
    const [broken] = await db
      .insert(events)
      .values({
        sessionId,
        type: "status",
        payload: { admission_state: "paused", reason: "overnight" },
      })
      .returning({ id: events.id });
    await appendLikeWorker(sessionId, 1);

    const response = await stream(sessionId);
    expect(response.status).toBe(200);
    const read = await collect(
      response,
      (frames) => frames.filter((f) => f.id).length >= 2,
    );
    const [unreadable, next] = read.frames
      .filter((f) => f.id)
      .map((frame) =>
        sseEventSchema.parse({
          id: frame.id,
          event: frame.event,
          data: JSON.parse(frame.data ?? "null"),
        }),
      );
    expect(unreadable?.id).toBe(encodeEventCursor(broken?.id ?? 0));
    expect(unreadable?.event).toBe("error");
    expect(unreadable?.data.data).toMatchObject({
      code: UNREADABLE_EVENT_CODE,
    });
    expect(next).toMatchObject({
      event: "status",
      data: { data: { phase: "running" } },
    });
    expect(
      sink.records.some(
        (record) =>
          record.message === "Stored event does not match the contract" &&
          record.fields?.session_id === sessionId,
      ),
    ).toBe(true);

    // A client that reconnects from the replaced row resumes after it.
    const resumed = await stream(sessionId, {
      "Last-Event-ID": unreadable?.id ?? "",
    });
    expect(resumed.status).toBe(200);
    const rest = await collect(resumed, (frames) =>
      frames.some((f) => f.id === next?.id),
    );
    expect(rest.frames.filter((f) => f.id).map((f) => f.id)).toEqual([
      next?.id,
    ]);
  }, 30_000);

  test("a replay page is cut by payload bytes, never below one row", async () => {
    const sessionId = await createdSession();
    // ~30 bytes each in the row, so a 100-byte page holds three; a bound
    // smaller than one row still yields that row or nothing could be read.
    await appendLikeWorker(sessionId, 10);
    const reader = createPostgresSessionReader(db);
    const page = await reader.readEvents(owner, sessionId, {
      limit: 100,
      maxBytes: 100,
    });
    expect(page?.more).toBe(true);
    expect(page?.items.length).toBeGreaterThanOrEqual(1);
    expect(page?.items.length).toBeLessThan(10);
    const tiny = await reader.readEvents(owner, sessionId, {
      limit: 100,
      maxBytes: 1,
    });
    expect(tiny?.items.length).toBe(1);
    expect(tiny?.more).toBe(true);
    const all = await reader.readEvents(owner, sessionId, {
      limit: 100,
      maxBytes: 1024 * 1024,
    });
    expect(all?.items.length).toBe(10);
    expect(all?.more).toBe(false);
    expect(all?.items[0]?.data.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("the byte bound counts serialized size, not TOAST-compressed size", async () => {
    const sessionId = await createdSession();
    // A repetitive 60 KiB document compresses to well under 1 KiB on disk;
    // the page must still count it at its serialized size.
    const filler = "x".repeat(60_000);
    await db.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      await tx.insert(events).values(
        Array.from({ length: 20 }, (_, i) => ({
          sessionId,
          type: "status",
          payload: { phase: "running", n: i, filler },
          attemptId: "a1",
        })),
      );
    });
    const reader = createPostgresSessionReader(db);
    const page = await reader.readEvents(owner, sessionId, {
      limit: 100,
      maxBytes: 256 * 1024,
    });
    expect(page?.items.length).toBe(4);
    expect(page?.more).toBe(true);
  });

  test("a page over a long history scans only `limit` candidate rows", async () => {
    const sessionId = await createdSession();
    for (let i = 0; i < 50; i += 1) await appendLikeWorker(sessionId, 100);
    const explained = (await db.execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${eventPageQuery(sessionId, 0, 100, 1024 * 1024)}`,
    )) as { rows: { "QUERY PLAN": unknown }[] };
    // Every Limit node in the plan must have produced at most `limit` rows;
    // the window functions then only see that candidate set.
    const limits: number[] = [];
    const walk = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      const plan = node as {
        "Node Type"?: string;
        "Actual Rows"?: number;
        Plans?: unknown[];
      };
      if (plan["Node Type"] === "Limit") limits.push(plan["Actual Rows"] ?? 0);
      for (const child of plan.Plans ?? []) walk(child);
    };
    const [root] = explained.rows;
    const top = root?.["QUERY PLAN"] as { Plan?: unknown }[] | undefined;
    walk(top?.[0]?.Plan);
    expect(limits.length).toBeGreaterThan(0);
    for (const rows of limits) expect(rows).toBeLessThanOrEqual(100);
  }, 30_000);

  test("rows appended during replay arrive in order with no gap", async () => {
    const sessionId = await createdSession();
    await appendLikeWorker(sessionId, 250);
    const response = await stream(sessionId);
    // Append while the replay is still paging, then keep appending live.
    const writer = (async () => {
      for (let i = 0; i < 6; i += 1) {
        await appendLikeWorker(sessionId, 50);
        await Bun.sleep(5);
      }
    })();
    const got = await collect(
      response,
      (frames) => frames.filter((f) => f.id).length >= 550,
    );
    await writer;
    const stored = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.id));
    const expected = stored.map((row) => `ev_${row.id.toString(36)}`);
    const seen = got.frames.filter((f) => f.id).map((f) => f.id);
    expect(seen).toEqual(expected);
  }, 30_000);

  test("a NOTIFY wakes an idle stream well inside the keepalive", async () => {
    const sessionId = await createdSession();
    const response = await stream(sessionId);
    // Idle: the first thing on the wire is a keepalive comment.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");

    const started = Date.now();
    await appendLikeWorker(sessionId, 1);
    const next = await reader.read();
    const elapsed = Date.now() - started;
    expect(new TextDecoder().decode(next.value)).toContain("event: status");
    expect(elapsed).toBeLessThan(KEEPALIVE_MS);
    await reader.cancel();
  }, 15_000);

  test("a revoked API key ends the stream within one keepalive", async () => {
    const sessionId = await createdSession();
    const store = new DatabaseApiKeyStore(db);
    const { keyId, plaintext } = await issueApiKey(store, {
      ownerId: owner,
      scopes: [...SESSION_SCOPE_VALUES],
    });
    const response = await stream(
      sessionId,
      { Authorization: `Bearer ${plaintext}` },
      apiKeyApp,
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      ": keepalive\n\n",
    );
    const revokedAt = Date.now();
    expect((await store.revoke(keyId)).outcome).toBe("revoked");
    let done = false;
    while (!done) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => ({ done: false, value: undefined })),
      ]);
      if (chunk.value === undefined && !chunk.done) throw new Error("hung");
      done = chunk.done;
    }
    // The re-check runs every half interval, so one interval is the bound.
    expect(Date.now() - revokedAt).toBeLessThan(KEEPALIVE_MS + 50);
    expect(
      sink.records.some(
        (record) =>
          record.message === "SSE stream closed" &&
          record.fields?.reason === "credential_revoked",
      ),
    ).toBe(true);
    // And the key opens nothing new.
    const reopened = await stream(
      sessionId,
      { Authorization: `Bearer ${plaintext}` },
      apiKeyApp,
    );
    expect(reopened.status).toBe(401);
  }, 15_000);

  test("a disconnecting client releases the server handle", async () => {
    const sessionId = await createdSession();
    const controller = new AbortController();
    const before = handle.activeStreams();
    const response = await stream(sessionId, {}, app, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(handle.activeStreams()).toBe(before + 1);
    controller.abort();
    for (let i = 0; i < 200 && handle.activeStreams() > before; i += 1) {
      await Bun.sleep(5);
    }
    expect(handle.activeStreams()).toBe(before);
  });

  test("a cursor from another session or from the future is 400", async () => {
    const mine = await createdSession();
    const other = await createdSession();
    await appendLikeWorker(mine, 3);
    await appendLikeWorker(other, 3);
    const [foreign] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.sessionId, other))
      .orderBy(asc(events.id))
      .limit(1);
    const foreignCursor = `ev_${(foreign?.id ?? 0).toString(36)}`;
    const crossed = await stream(mine, { "Last-Event-ID": foreignCursor });
    expect(crossed.status).toBe(400);
    const future = await stream(mine, {
      "Last-Event-ID": `ev_${Number.MAX_SAFE_INTEGER.toString(36)}`,
    });
    expect(future.status).toBe(400);
    // The session's own cursor still works, and `ev_0` means "from the start".
    const own = await stream(mine, { "Last-Event-ID": "ev_0" });
    expect(own.status).toBe(200);
    const got = await collect(own, (f) => f.filter((x) => x.id).length >= 3);
    expect(got.frames.filter((f) => f.id)).toHaveLength(3);
  });

  test("another owner gets 404, a bad cursor 400, both as JSON", async () => {
    const sessionId = await createdSession();
    const foreign = await stream(sessionId, { "X-Owner-Id": stranger });
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("Content-Type")).toContain("application/json");
    const bad = await stream(sessionId, { "Last-Event-ID": "ev_zz!" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "BAD_REQUEST",
    );
  });
});
