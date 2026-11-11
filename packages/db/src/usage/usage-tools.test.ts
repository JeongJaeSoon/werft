import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { UsageSummaryFilter, UsageToolsFilter } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import * as schema from "../schema.ts";
import { events, sessions, users } from "../schema.ts";
import { projectToolCalls } from "../sessions/tool-calls.ts";
import { createPostgresUsageReader } from "../usage-reader.ts";

const OWNER = "owner-a";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const PERIOD: UsageToolsFilter = {
  period: {
    since: new Date("2026-10-20T00:00:00.000Z"),
    until: new Date("2026-10-21T00:00:00.000Z"),
  },
};
const installation: UsageSummaryFilter = { kind: "installation" };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: `${import.meta.dir}/../../migrations`,
  });
  await db.insert(users).values([
    { id: ME, email: "me@example.invalid", displayName: "me" },
    { id: OTHER, email: "other@example.invalid", displayName: "other" },
  ]);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE tool_call_days, tool_calls, tool_descriptions, events, sessions CASCADE`,
  );
  await db.execute(
    sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
  );
});

async function init(
  sessionId: string,
  tools: readonly { name: string; description?: unknown }[],
) {
  await insert(
    sessionId,
    "system",
    {},
    {
      type: "system",
      engine_event: { name: "init", category: "started" },
      tools,
    },
  );
}

async function session(createdBy = ME): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: OWNER,
    repoUrl: "https://example.invalid/app.git",
    branch: "main",
    createdByUserId: createdBy,
  });
  return id;
}

let sequence = 0;
type Stamp = {
  occurredAt?: Date | null;
  createdAt?: Date;
  attemptId?: string | null;
};

async function use(
  sessionId: string,
  id: string,
  name: string,
  stamp: Stamp & { parent?: string } = {},
) {
  await insert(sessionId, "tool_use", stamp, {
    type: "assistant",
    tool_call: { id, name, input: {} },
    parent_tool_use_id: stamp.parent ?? null,
  });
}

async function result(
  sessionId: string,
  data: { tool_call_id?: unknown; is_error?: boolean | null },
  stamp: Stamp = {},
) {
  await insert(sessionId, "tool_result", stamp, {
    type: "tool_result",
    tool_result: {
      tool_call_id: data.tool_call_id,
      is_error: data.is_error === undefined ? false : data.is_error,
      text: "done",
    },
  });
}

async function insert(
  sessionId: string,
  type: string,
  stamp: Stamp,
  payload: Record<string, unknown>,
) {
  sequence += 1;
  const attemptId = stamp.attemptId === undefined ? "att-1" : stamp.attemptId;
  await db.insert(events).values({
    sessionId,
    type,
    payload,
    attemptId,
    sourceSequence: attemptId === null ? null : sequence,
    occurredAt: stamp.occurredAt === undefined ? T0 : stamp.occurredAt,
    createdAt: stamp.createdAt ?? T0,
  });
}

// The reader counts what the reconciler projected; margin 0 projects all.
const tools = async (
  filter: UsageSummaryFilter = installation,
  period = PERIOD,
) => {
  await projectToolCalls(db, {
    batchSize: 1000,
    budgetMs: 60_000,
    marginSeconds: 0,
  });
  return createPostgresUsageReader(db).usageTools(filter, period, 200);
};

describe("usageTools", () => {
  test("a call without a result counts but is not timed", async () => {
    const s = await session();
    await use(s, "tu-1", "Bash");
    await use(s, "tu-2", "Bash", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-2" }, { occurredAt: at(1500) });
    expect(await tools()).toEqual([
      {
        name: "Bash",
        calls: 2,
        failed: 0,
        totalMs: 1500,
        // Medians come from a histogram: within 5% of the exact one.
        medianMs: 1467,
        maxMs: 1500,
      },
    ]);
  });

  test("a missing time on either side leaves the call untimed", async () => {
    const s = await session();
    await use(s, "tu-1", "Read", { occurredAt: null });
    await result(s, { tool_call_id: "tu-1" }, { occurredAt: at(100) });
    await use(s, "tu-2", "Read", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-2" }, { occurredAt: null });
    expect(await tools()).toEqual([
      { name: "Read", calls: 2, failed: 0, totalMs: 0, medianMs: 0, maxMs: 0 },
    ]);
  });

  test("only is_error true fails; no is_error succeeds; a non-boolean is neither but is timed", async () => {
    const s = await session();
    await use(s, "tu-ok", "Edit", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-ok" }, { occurredAt: at(100) });
    await use(s, "tu-fail", "Edit", { occurredAt: at(0) });
    await result(
      s,
      { tool_call_id: "tu-fail", is_error: true },
      { occurredAt: at(200) },
    );
    await use(s, "tu-false", "Edit", { occurredAt: at(0) });
    await result(
      s,
      { tool_call_id: "tu-false", is_error: false },
      { occurredAt: at(300) },
    );
    await use(s, "tu-text", "Edit", { occurredAt: at(0) });
    await result(
      s,
      { tool_call_id: "tu-text", is_error: null },
      { occurredAt: at(400) },
    );
    await use(s, "tu-null", "Edit", { occurredAt: at(0) });
    await result(
      s,
      { tool_call_id: "tu-null", is_error: null },
      { occurredAt: at(500) },
    );
    expect(await tools()).toEqual([
      {
        name: "Edit",
        calls: 5,
        failed: 1,
        totalMs: 1500,
        medianMs: 290,
        maxMs: 500,
      },
    ]);
  });

  test("a result without a readable tool_call_id pairs with nothing", async () => {
    const s = await session();
    await use(s, "tu-1", "Grep", { occurredAt: at(0) });
    await result(s, { is_error: true }, { occurredAt: at(100) });
    await result(
      s,
      { tool_call_id: 7, is_error: true },
      { occurredAt: at(100) },
    );
    expect(await tools()).toEqual([
      { name: "Grep", calls: 1, failed: 0, totalMs: 0, medianMs: 0, maxMs: 0 },
    ]);
  });

  test("pairs within one session and attempt, a null attempt with null", async () => {
    const a = await session();
    const b = await session();
    await use(a, "tu-1", "Bash", { occurredAt: at(0) });
    await use(b, "tu-1", "Bash", { occurredAt: at(0) });
    await result(
      b,
      { tool_call_id: "tu-1", is_error: true },
      { occurredAt: at(900) },
    );
    await use(a, "tu-2", "Bash", { occurredAt: at(0), attemptId: "att-1" });
    await result(
      a,
      { tool_call_id: "tu-2" },
      { occurredAt: at(50), attemptId: "att-2" },
    );
    await use(a, "tu-3", "Bash", { occurredAt: at(0), attemptId: null });
    await result(
      a,
      { tool_call_id: "tu-3" },
      { occurredAt: at(100), attemptId: null },
    );
    expect(await tools()).toEqual([
      {
        name: "Bash",
        calls: 4,
        failed: 1,
        totalMs: 1000,
        medianMs: 507,
        maxMs: 900,
      },
    ]);
  });

  test("the earlier of two results for one call wins", async () => {
    const s = await session();
    await use(s, "tu-1", "Bash", { occurredAt: at(0) });
    await result(s, { tool_call_id: "tu-1" }, { occurredAt: at(300) });
    await result(
      s,
      { tool_call_id: "tu-1", is_error: true },
      { occurredAt: at(100) },
    );
    expect(await tools()).toEqual([
      {
        name: "Bash",
        calls: 1,
        failed: 1,
        totalMs: 100,
        medianMs: 100,
        maxMs: 100,
      },
    ]);
  });

  test("counts subagent calls and cuts the period on the tool_use's stored time", async () => {
    const s = await session();
    await use(s, "tu-1", "Task");
    await use(s, "tu-2", "Read", { parent: "tu-1" });
    await use(s, "tu-3", "Read", {
      createdAt: new Date("2026-10-19T23:59:59.999Z"),
    });
    await use(s, "tu-4", "Read", {
      createdAt: new Date("2026-10-21T00:00:00.000Z"),
    });
    expect((await tools()).map((t) => [t.name, t.calls])).toEqual([
      ["Read", 1],
      ["Task", 1],
    ]);
  });

  test("scope=me counts the caller's sessions only", async () => {
    const mine = await session(ME);
    const theirs = await session(OTHER);
    await use(mine, "tu-1", "Bash");
    await use(theirs, "tu-1", "Bash");
    await use(theirs, "tu-2", "Read");
    const me: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: ME };
    expect((await tools(me)).map((t) => [t.name, t.calls])).toEqual([
      ["Bash", 1],
    ]);
    expect((await tools()).map((t) => [t.name, t.calls])).toEqual([
      ["Bash", 2],
      ["Read", 1],
    ]);
  });

  test("most calls first, names breaking ties, and a block that is no tool call is skipped", async () => {
    const s = await session();
    await use(s, "tu-1", "Read");
    await use(s, "tu-2", "Bash");
    await use(s, "tu-3", "Grep");
    await use(s, "tu-4", "Grep");
    await insert(
      s,
      "tool_use",
      {},
      {
        type: "assistant",
        text: "hi",
      },
    );
    expect((await tools()).map((t) => t.name)).toEqual([
      "Grep",
      "Bash",
      "Read",
    ]);
  });

  test("a tool carries the description its session's latest init declared; a tool none described has none", async () => {
    const s = await session();
    await init(s, [
      { name: "Bash" },
      { name: "mcp__docs__find", description: "Finds a page" },
      { name: "mcp__docs__odd", description: 7 },
      { name: "mcp__docs__long", description: "x".repeat(201) },
    ]);
    await use(s, "tu-1", "Bash");
    await use(s, "tu-2", "mcp__docs__find");
    await use(s, "tu-3", "mcp__docs__odd");
    await use(s, "tu-4", "mcp__docs__long");
    const described = async () =>
      Object.fromEntries(
        (await tools()).map((t) => [t.name, t.description ?? null]),
      );
    expect(await described()).toEqual({
      Bash: null,
      mcp__docs__find: "Finds a page",
      mcp__docs__odd: null,
      mcp__docs__long: null,
    });
    // A later init of the session replaces it; read again, nothing changes.
    await init(s, [{ name: "mcp__docs__find", description: "Finds a doc" }]);
    expect((await described()).mcp__docs__find).toBe("Finds a doc");
    await db.execute(
      sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
    );
    expect((await described()).mcp__docs__find).toBe("Finds a doc");
  });

  test("scope=me sees only descriptions its own sessions declared", async () => {
    const mine = await session(ME);
    const theirs = await session(OTHER);
    await init(theirs, [{ name: "mcp__docs__find", description: "Theirs" }]);
    await use(mine, "tu-1", "mcp__docs__find");
    await use(theirs, "tu-1", "mcp__docs__find");
    const me: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: ME };
    expect((await tools(me))[0]?.description).toBeUndefined();
    expect((await tools())[0]?.description).toBe("Theirs");
  });
});
