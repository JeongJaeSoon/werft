import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  events,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { projectToolCalls, toolCallTotals } from "./sessions/tool-calls.ts";
import { bucketMs, histMedianMs } from "./sessions/tool-calls-hist.ts";
import { rowsOf } from "./statement-rows.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const OWNER = "owner-a";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const AGENT = "00000000-0000-4000-8000-0000000000bb";
const RELEASE = "rel-tool-calls";
const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  await db.insert(users).values([
    { id: ME, email: "me@example.invalid", displayName: "me" },
    { id: OTHER, email: "other@example.invalid", displayName: "other" },
  ]);
  await db.insert(workspaces).values({ id: WORKSPACE, slug: "ws", name: "ws" });
  await db.insert(agents).values({
    id: AGENT,
    workspaceId: WORKSPACE,
    managingTeamId: await fixtureTeam(db, WORKSPACE),
    slug: "bot",
    name: "bot",
  });
  const versionId = crypto.randomUUID();
  await db.insert(agentVersions).values({
    id: versionId,
    agentId: AGENT,
    versionNo: 1,
    card: { role: "r", instructions: "i", model: "m", capabilities: {} },
    contentSha256: "0".repeat(64),
  });
  await db.insert(agentReleases).values({
    id: RELEASE,
    agentId: AGENT,
    versionId,
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: {},
    effectiveTools: [],
  });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE tool_call_days, tool_calls, events, sessions CASCADE`,
  );
  await db.execute(
    sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
  );
  // Events here carry their neutral fields already: the fill has passed them.
  await db.execute(
    sql`UPDATE neutral_field_progress SET filled_through = 9223372036854775807 WHERE id = 1`,
  );
});

async function session(
  options: { createdBy?: string; agent?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: OWNER,
    repoUrl: "https://example.invalid/app.git",
    branch: "main",
    createdByUserId: options.createdBy ?? ME,
    ...(options.agent
      ? { agentReleaseId: RELEASE, ...sessionPinColumns() }
      : {}),
  });
  return id;
}

let sequence = 0;
type Stamp = {
  occurredAt?: Date | null;
  // Omitted: the default, the inserting transaction's start.
  createdAt?: Date | "now";
  attemptId?: string | null;
};

async function insert(
  sessionId: string,
  type: string,
  stamp: Stamp,
  payload: Record<string, unknown>,
) {
  sequence += 1;
  const attemptId = stamp.attemptId === undefined ? "att-1" : stamp.attemptId;
  const createdAt = stamp.createdAt ?? T0;
  await db.insert(events).values({
    sessionId,
    type,
    payload,
    attemptId,
    sourceSequence: attemptId === null ? null : sequence,
    occurredAt: stamp.occurredAt === undefined ? T0 : stamp.occurredAt,
    ...(createdAt === "now" ? {} : { createdAt }),
  });
}

const use = (
  sessionId: string,
  id: string,
  name: string,
  stamp: Stamp & { parent?: string } = {},
) =>
  insert(sessionId, "tool_use", stamp, {
    type: "assistant",
    tool_call: { id, name, input: {} },
    parent_tool_use_id: stamp.parent ?? null,
  });

const result = (
  sessionId: string,
  data: { tool_call_id?: unknown; is_error?: boolean | null },
  stamp: Stamp = {},
) =>
  insert(sessionId, "tool_result", stamp, {
    type: "tool_result",
    tool_result: {
      tool_call_id: data.tool_call_id,
      is_error: data.is_error === undefined ? false : data.is_error,
      text: "done",
    },
  });

const project = (batchSize = 1000) =>
  projectToolCalls(db, { batchSize, budgetMs: 60_000 });

type Figures = {
  name: string;
  calls: number;
  failed: number;
  timed: number;
  total_ms: number;
};

const figures = async (query: ReturnType<typeof sql>): Promise<Figures[]> =>
  rowsOf<Record<keyof Figures, string>>(await db.execute(query)).map((row) => ({
    name: row.name,
    calls: Number(row.calls),
    failed: Number(row.failed),
    timed: Number(row.timed),
    total_ms: Number(row.total_ms),
  }));

// The day rows of one scope, summed per tool.
const days = (scopeKey = "", agentKey = "") =>
  figures(sql`
    SELECT name, sum(calls) AS calls, sum(failed) AS failed,
      sum(timed) AS timed, sum(total_ms) AS total_ms
    FROM tool_call_days WHERE scope_key = ${scopeKey} AND agent_key = ${agentKey}
    GROUP BY name ORDER BY name`);

// The answer straight from events, as GET /v1/usage/tools would compute it
// without the projection: the run tree's pairing over every event.
const fromEvents = () =>
  figures(sql`
    WITH uses AS (
      SELECT DISTINCT ON (e.session_id, coalesce(e.attempt_id, ''), e.payload->'tool_call'->>'id')
        e.session_id, coalesce(e.attempt_id, '') AS attempt_key, e.payload->'tool_call'->>'id' AS tool_use_id,
        e.payload->'tool_call'->>'name' AS name, e.occurred_at
      FROM events e
      WHERE e.type = 'tool_use' AND jsonb_typeof(e.payload->'tool_call'->'id') = 'string'
        AND jsonb_typeof(e.payload->'tool_call'->'name') = 'string'
      ORDER BY e.session_id, coalesce(e.attempt_id, ''), e.payload->'tool_call'->>'id', e.id
    ), results AS (
      SELECT DISTINCT ON (e.session_id, coalesce(e.attempt_id, ''), e.payload->'tool_result'->>'tool_call_id')
        e.session_id, coalesce(e.attempt_id, '') AS attempt_key, e.payload->'tool_result'->>'tool_call_id' AS tool_use_id,
        e.occurred_at, e.payload->'tool_result'->'is_error' = 'true'::jsonb AS failed
      FROM events e
      WHERE e.type = 'tool_result' AND jsonb_typeof(e.payload->'tool_result'->'tool_call_id') = 'string'
      ORDER BY e.session_id, coalesce(e.attempt_id, ''), e.payload->'tool_result'->>'tool_call_id', coalesce(e.occurred_at, 'infinity'), e.id
    ), calls AS (
      SELECT u.name, coalesce(r.failed, false) AS failed,
        CASE WHEN r.occurred_at IS NOT NULL AND u.occurred_at IS NOT NULL
          THEN greatest(round(extract(epoch FROM r.occurred_at - u.occurred_at) * 1000), 0)
        END AS ms
      FROM uses u LEFT JOIN results r
        ON r.session_id = u.session_id AND r.attempt_key = u.attempt_key AND r.tool_use_id = u.tool_use_id
    )
    SELECT name, count(*) AS calls, count(*) FILTER (WHERE failed) AS failed,
      count(ms) AS timed, coalesce(sum(ms), 0) AS total_ms
    FROM calls GROUP BY name ORDER BY name`);

// Every pairing rule GET /v1/usage/tools states, in two sessions.
async function everyRule() {
  const a = await session({ agent: true });
  const b = await session({ createdBy: OTHER });
  // No result yet.
  await use(a, "tu-open", "Bash");
  // A time missing on either side.
  await use(a, "tu-nouse", "Read", { occurredAt: null });
  await result(a, { tool_call_id: "tu-nouse" }, { occurredAt: at(100) });
  await use(a, "tu-nores", "Read", { occurredAt: at(0) });
  await result(a, { tool_call_id: "tu-nores" }, { occurredAt: null });
  // is_error absent, true, false, and null (the engine said neither) twice.
  for (const [id, data, ms] of [
    ["tu-ok", {}, 100],
    ["tu-fail", { is_error: true }, 200],
    ["tu-false", { is_error: false }, 300],
    ["tu-text", { is_error: null }, 400],
    ["tu-null", { is_error: null }, 500],
  ] as const) {
    await use(a, id, "Edit", { occurredAt: at(0) });
    await result(a, { tool_call_id: id, ...data }, { occurredAt: at(ms) });
  }
  // A result with no string tool_call_id pairs with nothing.
  await use(a, "tu-lost", "Grep", { occurredAt: at(0) });
  await result(a, { is_error: true }, { occurredAt: at(10) });
  await result(a, { tool_call_id: 7, is_error: true }, { occurredAt: at(10) });
  // The same id in another session, another attempt, a null attempt.
  await use(b, "tu-open", "Bash", { occurredAt: at(0) });
  await result(
    b,
    { tool_call_id: "tu-open", is_error: true },
    { occurredAt: at(900) },
  );
  await use(a, "tu-att", "Bash", { occurredAt: at(0), attemptId: "att-1" });
  await result(
    a,
    { tool_call_id: "tu-att" },
    { occurredAt: at(50), attemptId: "att-2" },
  );
  await use(a, "tu-nullatt", "Bash", { occurredAt: at(0), attemptId: null });
  await result(
    a,
    { tool_call_id: "tu-nullatt" },
    { occurredAt: at(70), attemptId: null },
  );
  // Of two results, the earlier one by occurred_at.
  await use(a, "tu-twice", "Bash", { occurredAt: at(0) });
  await result(a, { tool_call_id: "tu-twice" }, { occurredAt: at(300) });
  await result(
    a,
    { tool_call_id: "tu-twice", is_error: true },
    { occurredAt: at(120) },
  );
  // A subagent's call, and a block that is no tool call.
  await use(a, "tu-sub", "Read", { parent: "tu-open" });
  await insert(a, "tool_use", {}, { type: "assistant", text: "x" });
  return { a, b };
}

describe("projectToolCalls", () => {
  test("counts what the events count, by every pairing rule", async () => {
    await everyRule();
    const projection = await project();
    expect(projection.caughtUp).toBe(true);
    const raw = await fromEvents();
    expect(raw.map((row) => row.name)).toEqual([
      "Bash",
      "Edit",
      "Grep",
      "Read",
    ]);
    expect(await days()).toEqual(raw);
    expect(
      await figures(sql`
        SELECT name, count(*) AS calls, count(*) FILTER (WHERE outcome = 'failed') AS failed,
          count(ms) AS timed, coalesce(sum(ms), 0) AS total_ms
        FROM tool_calls GROUP BY name ORDER BY name`),
    ).toEqual(raw);
    // The rules' own figures, so the oracle is not the only witness.
    expect(raw).toEqual([
      { name: "Bash", calls: 5, failed: 2, timed: 3, total_ms: 1090 },
      { name: "Edit", calls: 5, failed: 1, timed: 5, total_ms: 1500 },
      { name: "Grep", calls: 1, failed: 0, timed: 0, total_ms: 0 },
      { name: "Read", calls: 3, failed: 0, timed: 0, total_ms: 0 },
    ]);
  });

  test("a non-boolean is_error leaves the outcome unknown, and a call without a result unknown and untimed", async () => {
    const s = await session();
    await use(s, "tu-text", "Edit", { occurredAt: at(0) });
    await result(
      s,
      { tool_call_id: "tu-text", is_error: null },
      { occurredAt: at(400) },
    );
    await use(s, "tu-open", "Edit");
    await project();
    const rows = rowsOf<{
      tool_use_id: string;
      outcome: string;
      ms: string | null;
    }>(
      await db.execute(
        sql`SELECT tool_use_id, outcome, ms::text FROM tool_calls ORDER BY tool_use_id`,
      ),
    );
    expect(rows).toEqual([
      { tool_use_id: "tu-open", outcome: "unknown", ms: null },
      { tool_use_id: "tu-text", outcome: "unknown", ms: "400" },
    ]);
  });

  test("a second pass, small batches and a pass from cursor 0 change nothing", async () => {
    await everyRule();
    const snapshot = async () => ({
      calls: rowsOf(
        await db.execute(
          sql`SELECT * FROM tool_calls ORDER BY use_event_id, ord`,
        ),
      ),
      days: rowsOf(
        await db.execute(
          sql`SELECT * FROM tool_call_days ORDER BY scope_key, agent_key, day, name`,
        ),
      ),
    });
    const small = await project(3);
    expect(small.batches).toBeGreaterThan(5);
    const once = await snapshot();
    await project();
    expect(await snapshot()).toEqual(once);
    await db.execute(
      sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
    );
    await project();
    expect(await snapshot()).toEqual(once);
  });

  test("an earlier result arriving in a later pass trades the old time and outcome for its own", async () => {
    const s = await session();
    await use(s, "tu-1", "Bash", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-1" }, { occurredAt: at(3000) });
    await project();
    await result(
      s,
      { tool_call_id: "tu-1", is_error: true },
      { occurredAt: at(100) },
    );
    await project();
    expect(await days()).toEqual([
      { name: "Bash", calls: 1, failed: 1, timed: 1, total_ms: 100 },
    ]);
    const [row] = rowsOf<{ hist: number[]; max_ms: string }>(
      await db.execute(
        sql`SELECT hist, max_ms::text FROM tool_call_days WHERE scope_key = '' AND agent_key = ''`,
      ),
    );
    expect(row?.hist.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(histMedianMs(row?.hist ?? [], 3000)).toBe(bucketMs(49));
    // max_ms is never lowered.
    expect(row?.max_ms).toBe("3000");
  });

  test("the cursor passes only events older than the margin, and newer ones read again count once", async () => {
    const s = await session();
    await use(s, "tu-old", "Bash", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-old" }, { occurredAt: at(10) });
    const [old] = rowsOf<{ id: string }>(
      await db.execute(sql`SELECT max(id) AS id FROM events`),
    );
    await use(s, "tu-new", "Bash", { createdAt: "now" });
    await result(s, { tool_call_id: "tu-new" }, { createdAt: "now" });
    const first = await project();
    expect(first.appliedThrough).toBe(Number(old?.id));
    const second = await project();
    expect(second.appliedThrough).toBe(Number(old?.id));
    expect(second.eventsRead).toBe(2);
    expect(await days()).toEqual([
      { name: "Bash", calls: 2, failed: 0, timed: 2, total_ms: 10 },
    ]);
  });

  test("adds each call to the installation, its starter's and its agent's rows", async () => {
    const mine = await session({ agent: true });
    const theirs = await session({ createdBy: OTHER });
    await use(mine, "tu-1", "Bash");
    await use(theirs, "tu-1", "Read");
    await project();
    const scopes = rowsOf<{
      scope_key: string;
      agent_key: string;
      name: string;
    }>(
      await db.execute(
        sql`SELECT scope_key, agent_key, name FROM tool_call_days ORDER BY scope_key, agent_key, name`,
      ),
    );
    expect(scopes).toEqual([
      { scope_key: "", agent_key: "", name: "Bash" },
      { scope_key: "", agent_key: "", name: "Read" },
      { scope_key: "", agent_key: AGENT, name: "Bash" },
      { scope_key: `user:${ME}:${OWNER}`, agent_key: "", name: "Bash" },
      { scope_key: `user:${ME}:${OWNER}`, agent_key: AGENT, name: "Bash" },
      { scope_key: `user:${OTHER}:${OWNER}`, agent_key: "", name: "Read" },
    ]);
  });

  test("stops when its budget runs out and carries on next pass", async () => {
    await everyRule();
    let clock = 0;
    const first = await projectToolCalls(db, {
      batchSize: 5,
      budgetMs: 1,
      now: () => clock++,
    });
    expect(first).toMatchObject({ batches: 1, caughtUp: false });
    await project();
    expect(await days()).toEqual(await fromEvents());
  });

  test("a batch cut by the statement timeout is retried at a tenth of the size; other errors are not", async () => {
    await everyRule();
    const [events] = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM events`),
    );
    const n = events?.n ?? 0;
    const failing = (failures: number, code: string) =>
      Object.create(db, {
        transaction: {
          value: (fn: Parameters<typeof db.transaction>[0]) => {
            if (failures-- > 0) {
              return Promise.reject(
                new Error("Failed query", { cause: { code } }),
              );
            }
            return db.transaction(fn);
          },
        },
      }) as typeof db;
    await expect(
      projectToolCalls(failing(1, "40P01"), { batchSize: 8, budgetMs: 60_000 }),
    ).rejects.toThrow("Failed query");
    const reset = async () => {
      await db.execute(sql`TRUNCATE tool_call_days, tool_calls`);
      await db.execute(
        sql`UPDATE tool_call_progress SET applied_through = 0, batch_size = NULL WHERE id = 1`,
      );
    };
    const storedSize = async () =>
      rowsOf<{ batch_size: number | null }>(
        await db.execute(
          sql`SELECT batch_size FROM tool_call_progress WHERE id = 1`,
        ),
      )[0]?.batch_size;
    await expect(
      projectToolCalls(failing(99, "57014"), {
        batchSize: 8,
        budgetMs: 60_000,
      }),
    ).rejects.toThrow("Failed query");
    // Committed before the pass failed: the next one starts there.
    expect(await storedSize()).toBe(1);
    await reset();
    // A budget spent on the failures still gets one batch through.
    let clock = 0;
    const once = await projectToolCalls(failing(2, "57014"), {
      batchSize: 100,
      budgetMs: 1,
      now: () => clock++,
    });
    expect(once).toMatchObject({ batches: 1, eventsRead: 1 });
    await reset();
    const sizes: [number, number][] = [];
    const cut = await projectToolCalls(failing(2, "57014"), {
      batchSize: 100,
      budgetMs: 60_000,
      onTimeout: (size, retry) => sizes.push([size, retry]),
    });
    // 100 → 10 → 1 event a batch, then one empty batch to see it is done.
    expect(sizes).toEqual([
      [100, 10],
      [10, 1],
    ]);
    expect(cut).toMatchObject({
      batches: n + 1,
      eventsRead: n,
      caughtUp: true,
      timedOut: 2,
    });
    expect(await days()).toEqual(await fromEvents());
    // The next pass starts at the cut size; clean passes grow it back.
    expect(await storedSize()).toBe(1);
    await reset();
    await db.execute(
      sql`UPDATE tool_call_progress SET batch_size = 1 WHERE id = 1`,
    );
    const small = await projectToolCalls(db, {
      batchSize: 100,
      budgetMs: 60_000,
    });
    expect(small).toMatchObject({ batches: n + 1, eventsRead: n });
    expect(await storedSize()).toBe(10);
    await projectToolCalls(db, { batchSize: 100, budgetMs: 60_000 });
    expect(await storedSize()).toBeNull();
  });
});

describe("toolCallTotals", () => {
  const totals = (
    filter: Parameters<typeof toolCallTotals>[1],
    since: string,
    until: string,
    agentId?: string,
  ) =>
    toolCallTotals(db, filter, {
      since: new Date(since),
      until: new Date(until),
      limit: 200,
      ...(agentId === undefined ? {} : { agentId }),
    });
  const installation = { kind: "installation" } as const;

  test("a period still open reads today from its day row, not call by call", async () => {
    const s = await session();
    await use(s, "tu-1", "Bash", { createdAt: "now" });
    await use(s, "tu-2", "Bash", { createdAt: "now" });
    await projectToolCalls(db, {
      batchSize: 1000,
      budgetMs: 60_000,
      marginSeconds: 0,
    });
    const today = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const read = (until?: Date) =>
      toolCallTotals(db, installation, {
        since: yesterday,
        ...(until === undefined ? {} : { until }),
        limit: 200,
      });
    const calls = async (until?: Date) =>
      (await read(until)).map((t) => [t.name, t.calls]);
    expect(await calls()).toEqual([["Bash", 2]]);
    // Without the calls themselves only the day rows answer.
    await db.execute(sql`TRUNCATE tool_calls`);
    expect(await calls()).toEqual([["Bash", 2]]);
    expect(await calls(new Date(Date.now() + 3_600_000))).toEqual([
      ["Bash", 2],
    ]);
    // A period that ended reads its last part call by call.
    expect(await calls(new Date(Date.now() - 1))).toEqual([]);
  });

  test("reads the same figures from whole days, from the ends alone and from both", async () => {
    await everyRule();
    await project();
    const raw = await fromEvents();
    const expected = raw.map(({ timed: _, total_ms, ...rest }) => ({
      ...rest,
      totalMs: total_ms,
    }));
    for (const [since, until] of [
      ["2026-10-19T00:00:00Z", "2026-10-22T00:00:00Z"],
      ["2026-10-20T06:00:00Z", "2026-10-20T18:00:00Z"],
      ["2026-10-19T06:00:00Z", "2026-10-22T06:00:00Z"],
    ] as const) {
      const rows = await totals(installation, since, until);
      expect(
        rows.map(({ medianMs: _m, maxMs: _x, ...rest }) => rest),
        `${since} ${until}`,
      ).toEqual(
        [...expected].sort(
          (a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1),
        ),
      );
    }
    expect(
      await totals(
        installation,
        "2026-10-21T00:00:00Z",
        "2026-10-22T00:00:00Z",
      ),
    ).toEqual([]);
  });

  test("cuts on each call's stored day, across an edge, whole days and the other edge", async () => {
    const s = await session();
    const days = [
      "2026-10-18T20:00:00Z", // before the period
      "2026-10-19T20:00:00Z", // start edge
      "2026-10-20T12:00:00Z", // whole day
      "2026-10-21T03:00:00Z", // end edge
      "2026-10-21T09:00:00Z", // after the period
    ];
    for (const [i, createdAt] of days.entries()) {
      await use(s, `tu-${i}`, "Bash", {
        createdAt: new Date(createdAt),
        occurredAt: new Date(createdAt),
      });
      await result(
        s,
        { tool_call_id: `tu-${i}` },
        {
          createdAt: new Date(createdAt),
          occurredAt: new Date(new Date(createdAt).getTime() + 1000 * (i + 1)),
        },
      );
    }
    await project();
    const [bash] = await totals(
      installation,
      "2026-10-19T12:00:00Z",
      "2026-10-21T06:00:00Z",
    );
    expect(bash).toEqual({
      name: "Bash",
      calls: 3,
      failed: 0,
      totalMs: 2000 + 3000 + 4000,
      medianMs: bucketMs(1 + Math.floor(Math.log(3000) / Math.log(1.1))),
      maxMs: 4000,
    });
  });

  test("scope=me and an agent read their own sessions, whole days and ends alike", async () => {
    const mine = await session({ agent: true });
    const theirs = await session({ createdBy: OTHER, agent: true });
    const plain = await session();
    await use(mine, "tu-1", "Bash");
    await use(theirs, "tu-1", "Bash");
    await use(plain, "tu-1", "Read");
    await project();
    const me = { kind: "user", ownerId: OWNER, userId: ME } as const;
    for (const [since, until] of [
      ["2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z"],
      ["2026-10-20T06:00:00Z", "2026-10-20T18:00:00Z"],
    ] as const) {
      const names = async (
        filter: Parameters<typeof toolCallTotals>[1],
        agentId?: string,
      ) =>
        (await totals(filter, since, until, agentId)).map((t) => [
          t.name,
          t.calls,
        ]);
      expect(await names(me)).toEqual([
        ["Bash", 1],
        ["Read", 1],
      ]);
      expect(await names(me, AGENT)).toEqual([["Bash", 1]]);
      expect(await names(me, AGENT.toUpperCase())).toEqual([["Bash", 1]]);
      expect(await names(installation, AGENT)).toEqual([["Bash", 2]]);
      expect(await names(installation)).toEqual([
        ["Bash", 2],
        ["Read", 1],
      ]);
    }
  });
});

describe("tool call histogram", () => {
  test("a duration read back from its bucket is within 5%", async () => {
    const samples = [
      1, 2, 3, 7, 10, 99, 100, 101, 999, 1234, 3100, 12_400, 61_000, 298_000,
      1_000_000, 3_600_000,
    ];
    const buckets = rowsOf<{ ms: string; bucket: number }>(
      await db.execute(sql`
        SELECT ms, tool_ms_bucket(ms) AS bucket
        FROM unnest(${`{${samples.join(",")}}`}::bigint[]) AS ms`),
    );
    for (const { ms, bucket } of buckets) {
      const back = bucketMs(bucket);
      expect(Math.abs(back - Number(ms)) / Number(ms), ms).toBeLessThanOrEqual(
        0.05,
      );
    }
    const [zero] = rowsOf<{ bucket: number }>(
      await db.execute(sql`SELECT tool_ms_bucket(0) AS bucket`),
    );
    expect(zero?.bucket).toBe(0);
  });

  test("the median is the middle call's bucket, the mean of the two middle ones of an even count, never above the max", () => {
    const hist = Array<number>(161).fill(0);
    expect(histMedianMs(hist, 0)).toBe(0);
    hist[10] = 1;
    hist[20] = 1;
    hist[30] = 1;
    expect(histMedianMs(hist, 999)).toBe(bucketMs(20));
    hist[40] = 1;
    expect(histMedianMs(hist, 999)).toBe(
      Math.round((bucketMs(20) + bucketMs(30)) / 2),
    );
    hist[30] = 2;
    expect(histMedianMs(hist, 999)).toBe(bucketMs(30));
    expect(histMedianMs([0, 1], 0)).toBe(0);
  });
});
