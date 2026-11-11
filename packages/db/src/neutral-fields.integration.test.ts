import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { SessionEventPayload } from "@werft-ai/contracts";
import type { NeutralizeEvent } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { fillNeutralFields, NEUTRAL_FILL_LOCK_KEY } from "./neutral-fields.ts";
import { createPostgresSessionReader } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import { projectToolCalls } from "./sessions/tool-calls.ts";
import { rowsOf } from "./statement-rows.ts";
import { sessionPinColumns } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// A codec stand-in for the claude engine: what a codec adds, from the
// engine's `message` a v1 event carries. A session with no runtime has none.
const neutralize: NeutralizeEvent = (runtimeKind, event) => {
  if (runtimeKind !== "claude_agent_sdk") return event;
  const data = event.data as Record<string, unknown>;
  const message = data.message as { call?: string; said?: string } | undefined;
  const added: Record<string, unknown> =
    event.event === "tool_use" && message?.call
      ? { tool_call: { id: message.call, name: "Bash", input: {} } }
      : event.event === "assistant" && message?.said
        ? { text: message.said }
        : {};
  const missing = Object.entries(added).filter(([key]) => !(key in data));
  return missing.length === 0
    ? event
    : ({
        ...event,
        data: { ...data, ...Object.fromEntries(missing) },
      } as SessionEventPayload);
};

integration("neutral field fill on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "neutral_fill_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE tool_call_days, tool_calls, events, sessions CASCADE`,
    );
    await db.execute(
      sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE neutral_field_progress SET filled_through = 0, history_through = 0 WHERE id = 1`,
    );
  });

  // "known": pinned on the claude engine, which has a codec; "unknown":
  // no spec, so no runtime and no codec.
  async function session(runtime: "known" | "unknown"): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "owner-a",
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      ...(runtime === "known" ? sessionPinColumns() : {}),
    });
    return id;
  }

  // Stored `age_seconds` ago, so the fill's margin is in the test's hands.
  async function stored(
    sessionId: string,
    events: Array<[type: string, payload: Record<string, unknown>]>,
    ageSeconds = 600,
  ) {
    await db.execute(sql`
      INSERT INTO events (session_id, type, payload, created_at)
      SELECT ${sessionId}, v.type, v.payload, now() - make_interval(secs => ${ageSeconds})
      FROM jsonb_to_recordset(${JSON.stringify(
        events.map(([type, payload]) => ({ type, payload })),
      )}::jsonb) AS v(type text, payload jsonb)`);
  }

  const payloads = async () =>
    rowsOf<{
      type: string;
      payload: Record<string, unknown>;
      neutral: Record<string, unknown> | null;
    }>(
      await db.execute(
        sql`SELECT type, payload, neutral FROM events ORDER BY id`,
      ),
    );

  const progress = async () => {
    const [row] = rowsOf<{ filled_through: string }>(
      await db.execute(
        sql`SELECT filled_through FROM neutral_field_progress WHERE id = 1`,
      ),
    );
    return Number(row?.filled_through);
  };

  const fill = (
    options: Partial<Parameters<typeof fillNeutralFields>[1]> = {},
  ) =>
    fillNeutralFields(db, {
      neutralize,
      batchSize: 100,
      budgetMs: 10_000,
      ...options,
    });

  test("stores only the fields an event lacks beside it and never rewrites the payload", async () => {
    const known = await session("known");
    const unknown = await session("unknown");
    await stored(known, [
      [
        "tool_use",
        { type: "assistant", message: { call: "tu-1" }, extra: { kept: true } },
      ],
      [
        "assistant",
        { type: "assistant", message: { said: "hi" }, text: "already there" },
      ],
      ["status", { phase: "running" }],
    ]);
    await stored(unknown, [
      ["tool_use", { type: "assistant", message: { call: "tu-2" } }],
    ]);

    const first = await fill();
    expect(first).toMatchObject({
      eventsRead: 4,
      filled: 1,
      caughtUp: true,
      busy: false,
    });
    expect(await payloads()).toEqual([
      {
        type: "tool_use",
        payload: {
          type: "assistant",
          message: { call: "tu-1" },
          extra: { kept: true },
        },
        neutral: { tool_call: { id: "tu-1", name: "Bash", input: {} } },
      },
      {
        type: "assistant",
        payload: {
          type: "assistant",
          message: { said: "hi" },
          text: "already there",
        },
        neutral: null,
      },
      { type: "status", payload: { phase: "running" }, neutral: null },
      // No codec for its runtime: kept as stored, and the cursor passes it.
      {
        type: "tool_use",
        payload: { type: "assistant", message: { call: "tu-2" } },
        neutral: null,
      },
    ]);
    expect(first.filledThrough).toBe(await progress());

    // A second pass over the same rows changes nothing, and fields already
    // stored beside an event are kept.
    await db.execute(
      sql`UPDATE neutral_field_progress SET filled_through = 0 WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE events SET neutral = '{"tool_call":{"id":"kept","name":"Read","input":{}}}' WHERE payload -> 'message' ->> 'call' = 'tu-1'`,
    );
    const before = await payloads();
    expect(await fill()).toMatchObject({ eventsRead: 4, filled: 0 });
    expect(await payloads()).toEqual(before);
  });

  test("a pass cut by its budget resumes from the stored cursor", async () => {
    const known = await session("known");
    await stored(
      known,
      Array.from({ length: 25 }, (_, i) => [
        "tool_use",
        { type: "assistant", message: { call: `tu-${i}` } },
      ]),
    );
    let clock = 0;
    // Each now() call moves past the budget, so the pass stops after one batch.
    const cut = await fill({ batchSize: 10, budgetMs: 1, now: () => clock++ });
    expect(cut).toMatchObject({ batches: 1, filled: 10, caughtUp: false });
    expect(await progress()).toBe(cut.filledThrough);

    const rest = await fill({ batchSize: 10 });
    expect(rest).toMatchObject({ eventsRead: 15, filled: 15, caughtUp: true });
    const filled = (await payloads()).filter(
      (row) => row.neutral !== null && "tool_call" in row.neutral,
    );
    expect(filled).toHaveLength(25);
  });

  test("the cursor stays before rows inside the margin", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "old" } }],
    ]);
    await stored(
      known,
      [["tool_use", { type: "assistant", message: { call: "new" } }]],
      0,
    );
    const pass = await fill({ marginSeconds: 60 });
    expect(pass.filled).toBe(2);
    const [oldest] = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT min(id) AS id FROM events`),
    );
    expect(await progress()).toBe(Number(oldest?.id));
  });

  test("a lower id still inside the margin holds the cursor before a safe higher one", async () => {
    const known = await session("known");
    await stored(
      known,
      [["tool_use", { type: "assistant", message: { call: "late" } }]],
      0,
    );
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "early" } }],
    ]);
    await fill({ marginSeconds: 60 });
    expect(await progress()).toBe(0);
  });

  test("a row inside the margin holds the cursor across the batches of a pass", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "a" } }],
    ]);
    await stored(
      known,
      [["tool_use", { type: "assistant", message: { call: "b" } }]],
      0,
    );
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "c" } }],
      ["tool_use", { type: "assistant", message: { call: "d" } }],
    ]);
    const [first] = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT min(id) AS id FROM events`),
    );
    await fill({ batchSize: 2, marginSeconds: 60 });
    expect(await progress()).toBe(Number(first?.id));
  });

  test("a replica that finds the fill taken leaves it alone", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "tu-1" } }],
    ]);
    const other = new Client({ connectionString: database.url });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [
        NEUTRAL_FILL_LOCK_KEY,
      ]);
      expect(await fill()).toMatchObject({ busy: true, filled: 0 });
      expect((await payloads())[0]?.neutral).toBeNull();
      await other.query("COMMIT");
    } finally {
      await other.end();
    }
    expect(await fill()).toMatchObject({ busy: false, filled: 1 });
  });

  test("a reader shows an event before the fill as it shows it after", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "tu-1" } }],
      ["assistant", { type: "assistant", message: { said: "hi" } }],
      ["status", { phase: "idle" }],
    ]);
    const frames = async (options: { neutralize?: NeutralizeEvent }) =>
      (
        await createPostgresSessionReader(db, options).readEvents(
          "owner-a",
          known,
          { limit: 100, maxBytes: 1 << 20 },
        )
      )?.items.map((frame) => ({ event: frame.event, data: frame.data.data }));

    const plain = await frames({});
    expect(plain?.[1]?.data).not.toHaveProperty("text");
    const before = await frames({ neutralize });
    expect(before?.[0]?.data).toMatchObject({ tool_call: { id: "tu-1" } });
    expect(before?.[1]?.data).toMatchObject({ text: "hi" });
    await fill();
    expect(await frames({})).toEqual(before);
    expect(await frames({ neutralize })).toEqual(before);
  });

  test("fields filled on read count against a page's byte bound", async () => {
    const known = await session("known");
    const said = "x".repeat(300);
    await stored(known, [
      ["assistant", { type: "assistant", message: { said } }],
      ["assistant", { type: "assistant", message: { said } }],
    ]);
    const reader = createPostgresSessionReader(db, { neutralize });
    // Both rows fit as stored; with their text filled, only the first does.
    const page = (after?: string) =>
      reader.readEvents("owner-a", known, {
        limit: 100,
        maxBytes: 1_000,
        ...(after === undefined ? {} : { after }),
      });
    const first = await page();
    expect(first?.items).toHaveLength(1);
    expect(first?.more).toBe(true);
    const second = await page(first?.items[0]?.id);
    expect(second?.items).toHaveLength(1);
    expect(second?.items[0]?.data.data).toMatchObject({ text: said });
    expect(second?.more).toBe(false);
  });

  test("tool calls in history stored before the neutral fields wait for the fill", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "tu-1" } }],
      ["tool_use", { type: "assistant", message: { call: "tu-2" } }],
    ]);
    await db.execute(sql`
      UPDATE neutral_field_progress
      SET history_through = (SELECT max(id) FROM events) WHERE id = 1`);
    const project = () =>
      projectToolCalls(db, { batchSize: 100, budgetMs: 10_000 });
    const calls = async () =>
      rowsOf<{ tool_use_id: string }>(
        await db.execute(
          sql`SELECT tool_use_id FROM tool_calls ORDER BY tool_use_id`,
        ),
      ).map((row) => row.tool_use_id);

    const held = await project();
    expect(held.appliedThrough).toBe(0);
    expect(held.heldByFillSeconds).not.toBeNull();
    expect(await calls()).toEqual([]);
    await fill();
    expect((await project()).heldByFillSeconds).toBeNull();
    expect(await calls()).toEqual(["tu-1", "tu-2"]);
  });

  test("a call an older replica stores after the history is projected once filled", async () => {
    const known = await session("known");
    await stored(known, [
      ["tool_use", { type: "assistant", message: { call: "tu-late" } }],
    ]);
    const project = () =>
      projectToolCalls(db, { batchSize: 100, budgetMs: 10_000 });
    expect((await project()).appliedThrough).toBe(0);
    await fill();
    await project();
    expect(
      rowsOf<{ tool_use_id: string }>(
        await db.execute(sql`SELECT tool_use_id FROM tool_calls`),
      ).map((row) => row.tool_use_id),
    ).toEqual(["tu-late"]);
  });

  test("a projection pass held by the fill reads no further", async () => {
    const known = await session("known");
    await stored(
      known,
      ["a", "b", "c", "d"].map((call) => [
        "tool_use",
        { type: "assistant", message: { call } },
      ]),
    );
    const pass = await projectToolCalls(db, { batchSize: 2, budgetMs: 10_000 });
    expect(pass).toMatchObject({ batches: 1, appliedThrough: 0 });
    expect(pass.heldByFillSeconds).not.toBeNull();
    await fill();
    await projectToolCalls(db, { batchSize: 2, budgetMs: 10_000 });
    expect(
      rowsOf<{ tool_use_id: string }>(
        await db.execute(
          sql`SELECT tool_use_id FROM tool_calls ORDER BY tool_use_id`,
        ),
      ).map((row) => row.tool_use_id),
    ).toEqual(["a", "b", "c", "d"]);
  });

  test("tens of thousands of stored events fill in batches that block no writer", async () => {
    const SESSIONS = 50;
    const PER_SESSION = 800;
    const ids = await Promise.all(
      Array.from({ length: SESSIONS }, () => session("known")),
    );
    for (const id of ids) {
      await stored(
        id,
        Array.from({ length: PER_SESSION }, (_, i) =>
          i % 2 === 0
            ? [
                "tool_use",
                { type: "assistant", message: { call: `${id}-${i}` } },
              ]
            : [
                "assistant",
                { type: "assistant", message: { said: `line ${i}` } },
              ],
        ),
      );
    }
    const total = SESSIONS * PER_SESSION;

    // A writer appending throughout the fill: each insert's latency shows
    // whether a batch holds a lock it waits on.
    let writing = true;
    const writes: number[] = [];
    const writer = (async () => {
      while (writing) {
        const started = performance.now();
        await pool.query(
          "INSERT INTO events (session_id, type, payload) VALUES ($1, 'status', '{\"phase\":\"running\"}')",
          [ids[0]],
        );
        writes.push(performance.now() - started);
      }
    })();

    const started = performance.now();
    let filled = 0;
    let batches = 0;
    for (;;) {
      const pass = await fill({ batchSize: 5_000, budgetMs: 10_000 });
      filled += pass.filled;
      batches += pass.batches;
      if (pass.caughtUp) break;
    }
    const elapsed = performance.now() - started;
    writing = false;
    await writer;

    writes.sort((a, b) => a - b);
    const p99 = writes[Math.floor(writes.length * 0.99)] ?? 0;
    console.log(
      `neutral fill: ${total} events, ${filled} filled in ${batches} batches, ` +
        `${Math.round(elapsed)}ms; concurrent inserts ${writes.length}, ` +
        `p99 ${p99.toFixed(1)}ms, max ${(writes.at(-1) ?? 0).toFixed(1)}ms`,
    );
    expect(filled).toBe(total);
    const [left] = rowsOf<{ n: string }>(
      await db.execute(sql`
        SELECT count(*) AS n FROM events
        WHERE (type = 'tool_use' AND NOT coalesce(neutral, '{}') ? 'tool_call')
           OR (type = 'assistant' AND NOT coalesce(neutral, '{}') ? 'text')`),
    );
    expect(Number(left?.n)).toBe(0);
    // A batch takes no lock on events beyond the rows it updates.
    expect(writes.at(-1) ?? 0).toBeLessThan(1_000);
  }, 120_000);
});
