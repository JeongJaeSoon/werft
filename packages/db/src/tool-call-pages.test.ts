import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  InvalidCursorError,
  type SessionViewer,
  type UsageSummaryFilter,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  events,
  sessionShares,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";
import { toolCallDays, toolCallPage } from "./tool-call-pages.ts";
import { projectToolCalls } from "./tool-calls.ts";

const OWNER = "owner-a";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const AGENT = "00000000-0000-4000-8000-0000000000bb";
const RELEASE = "rel-tool-call-pages";
const T0 = new Date("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SINCE = new Date("2026-10-20T00:00:00.000Z");
const UNTIL = new Date("2026-10-21T00:00:00.000Z");
const installation: UsageSummaryFilter = { kind: "installation" };
const me: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: ME };
const myView: SessionViewer = { userId: ME, apiKeyId: null };

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
    name: "Bot",
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
    sql`TRUNCATE tool_call_days, tool_calls, session_shares, events, sessions CASCADE`,
  );
  await db.execute(
    sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
  );
});

async function session(
  options: {
    createdBy?: string;
    owner?: string;
    agent?: boolean;
    share?: "private" | "workspace";
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const ownerId = options.owner ?? OWNER;
  await db.insert(sessions).values({
    id,
    ownerId,
    workspaceId: WORKSPACE,
    title: `title ${id.slice(0, 4)}`,
    repoUrl: "https://example.invalid/app.git",
    branch: "main",
    createdByUserId: options.createdBy ?? ME,
    ...(options.agent
      ? { agentReleaseId: RELEASE, ...sessionPinColumns() }
      : {}),
  });
  if (options.share) await share(id, options.share, ownerId);
  return id;
}

async function share(
  sessionId: string,
  scope: "private" | "workspace",
  ownerId = OWNER,
) {
  await db
    .insert(sessionShares)
    .values({ sessionId, ownerId, workspaceId: WORKSPACE, scope })
    .onConflictDoUpdate({ target: sessionShares.sessionId, set: { scope } });
}

let sequence = 0;
async function insert(
  sessionId: string,
  type: string,
  occurredAt: Date | null,
  payload: Record<string, unknown>,
  createdAt = T0,
) {
  sequence += 1;
  await db.insert(events).values({
    sessionId,
    type,
    payload,
    attemptId: "att-1",
    sourceSequence: sequence,
    occurredAt,
    createdAt,
  });
}

const use = (
  sessionId: string,
  id: string,
  occurredAt: Date | null = T0,
  createdAt = T0,
) =>
  insert(
    sessionId,
    "tool_use",
    occurredAt,
    {
      type: "assistant",
      tool_call: { id, name: "Bash", input: {} },
    },
    createdAt,
  );

const result = (
  sessionId: string,
  data: { tool_call_id?: unknown; is_error?: boolean | null },
  occurredAt: Date | null,
) =>
  insert(sessionId, "tool_result", occurredAt, {
    type: "tool_result",
    tool_result: {
      tool_call_id: data.tool_call_id,
      is_error: data.is_error === undefined ? false : data.is_error,
      text: "done",
    },
  });

async function page(
  options: {
    filter?: UsageSummaryFilter;
    sort?: "recent" | "slowest";
    limit?: number;
    cursor?: string;
    viewer?: SessionViewer;
  } = {},
) {
  await projectToolCalls(db, {
    batchSize: 1000,
    budgetMs: 60_000,
    marginSeconds: 0,
  });
  return toolCallPage(db, options.filter ?? installation, {
    period: { since: SINCE },
    until: UNTIL,
    name: "Bash",
    sort: options.sort ?? "recent",
    limit: options.limit ?? 20,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ownerId: OWNER,
    viewer: options.viewer ?? myView,
  });
}

// Every page from the first, by next_cursor.
async function walk(sort: "recent" | "slowest", limit: number) {
  const rows: (number | null)[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const next = await page({
      sort,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(
      next.calls.map((call) =>
        sort === "recent" ? call.occurredAt.getTime() : call.durationMs,
      ),
    );
    if (next.nextCursor === null) return rows;
    cursor = next.nextCursor;
  }
  throw new Error("no last page");
}

describe("toolCallPage", () => {
  test("a call without a result is unknown and untimed; a non-boolean is_error is unknown but timed", async () => {
    const s = await session({ agent: true });
    await use(s, "tu-open", at(0));
    await use(s, "tu-odd", at(10));
    await result(s, { tool_call_id: "tu-odd", is_error: null }, at(410));
    await use(s, "tu-bad", at(20));
    await result(s, { tool_call_id: "tu-bad", is_error: true }, at(120));
    await use(s, "tu-late", null);
    await result(s, { tool_call_id: "tu-late" }, at(500));
    const { calls } = await page();
    expect(
      calls.map((call) => [call.outcome, call.durationMs, call.agent]),
    ).toEqual([
      ["failed", 100, "Bot"],
      ["unknown", 400, "Bot"],
      // No occurred_at: shown at its stored time, T0 like tu-open, and
      // untimed; the later event goes first.
      ["ok", null, "Bot"],
      ["unknown", null, "Bot"],
    ]);
    const bare = await session();
    await use(bare, "tu-1", at(30));
    expect((await page()).calls[0]?.agent).toBeNull();
  });

  test("a session the caller may not read shows no id or title until shared with the workspace", async () => {
    const mine = await session({ share: "private" });
    const theirs = await session({ createdBy: OTHER, share: "private" });
    const elsewhere = await session({
      createdBy: OTHER,
      owner: "owner-b",
      share: "workspace",
    });
    await use(mine, "tu-1", at(30));
    await use(theirs, "tu-1", at(20));
    await use(elsewhere, "tu-1", at(10));
    const shown = async () =>
      (await page()).calls.map((call) => [call.sessionId, call.title]);
    const title = async (id: string) =>
      (
        await db
          .select({ title: sessions.title })
          .from(sessions)
          .where(sql`${sessions.id} = ${id}`)
      )[0]?.title ?? null;
    expect(await shown()).toEqual([
      [mine, await title(mine)],
      [null, null],
      // Another owner's session, workspace-wide there: still hidden here.
      [null, null],
    ]);
    await share(theirs, "workspace");
    expect(await shown()).toEqual([
      [mine, await title(mine)],
      [theirs, await title(theirs)],
      [null, null],
    ]);
  });

  test("scope=me lists the caller's sessions only", async () => {
    const mine = await session();
    const theirs = await session({ createdBy: OTHER });
    await use(mine, "tu-1", at(10));
    await use(theirs, "tu-1", at(20));
    const { calls } = await page({ filter: me });
    expect(calls.map((call) => call.sessionId)).toEqual([mine]);
  });

  test("pages through calls at one time with no row missed or repeated", async () => {
    // A session per call, so tied rows can be told apart by session id.
    const tied: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const s = await session();
      await use(s, `tu-${i}`, at(0));
      tied.push(s);
    }
    const later = await session();
    await use(later, "tu-later", at(5));
    const pages = await walk("recent", 3);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 2]);
    expect(pages.flat()).toEqual([
      at(5).getTime(),
      ...Array(7).fill(at(0).getTime()),
    ]);
    const sessions: (string | null)[] = [];
    let cursor: string | undefined;
    do {
      const next = await page({
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      sessions.push(...next.calls.map((call) => call.sessionId));
      cursor = next.nextCursor ?? undefined;
    } while (cursor !== undefined);
    // Ties go to the later event first, and each session was written in turn.
    expect(sessions).toEqual([later, ...[...tied].reverse()]);
  });

  test("slowest pages the longest first, ties by the later event, untimed calls last", async () => {
    const s = await session();
    for (const [id, ms] of [
      ["tu-a", 300],
      ["tu-b", 300],
      ["tu-c", null],
      ["tu-d", 100],
      ["tu-e", null],
      ["tu-f", 300],
    ] as const) {
      await use(s, id, at(0));
      if (ms !== null) await result(s, { tool_call_id: id }, at(ms));
    }
    const pages = await walk("slowest", 2);
    expect(pages).toEqual([
      [300, 300],
      [300, 100],
      [null, null],
    ]);
  });

  test("a cursor from the other sort, or no cursor at all, is refused", async () => {
    const s = await session();
    await use(s, "tu-1", at(0));
    await use(s, "tu-2", at(1));
    const first = await page({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    for (const cursor of [
      first.nextCursor ?? "",
      "not-a-cursor",
      Buffer.from(
        JSON.stringify({ sort: "slowest", ms: -1, id: 1, ord: 1 }),
      ).toString("base64url"),
    ]) {
      await expect(page({ sort: "slowest", cursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
    const forged = Buffer.from(
      JSON.stringify({
        sort: "recent",
        at: "2026-13-40 00:00:00+00",
        id: 1,
        ord: 1,
      }),
    ).toString("base64url");
    await expect(page({ cursor: forged })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    // Past a Postgres integer: refused here, not a cast error from the query.
    const huge = Buffer.from(
      JSON.stringify({
        sort: "recent",
        at: "2026-10-20 00:00:00+00",
        id: 1,
        ord: 2_147_483_648,
      }),
    ).toString("base64url");
    await expect(page({ cursor: huge })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });
});

describe("toolCallDays", () => {
  test("every UTC date the period touches, zeros included, whole days and ends alike", async () => {
    const s = await session();
    const day = (iso: string) => new Date(iso);
    await use(s, "tu-1", null, day("2026-10-20T23:00:00Z"));
    await use(s, "tu-2", null, day("2026-10-22T01:00:00Z"));
    await use(s, "tu-3", null, day("2026-10-22T13:00:00Z"));
    await use(s, "tu-4", null, day("2026-10-23T05:00:00Z"));
    await projectToolCalls(db, {
      batchSize: 1000,
      budgetMs: 60_000,
      marginSeconds: 0,
    });
    const days = (
      since: string,
      until: string,
      filter: UsageSummaryFilter = installation,
    ) =>
      toolCallDays(db, filter, {
        name: "Bash",
        since: day(since),
        until: day(until),
      });
    expect(await days("2026-10-20T12:00:00Z", "2026-10-23T06:00:00Z")).toEqual([
      { date: "2026-10-20", calls: 1 },
      { date: "2026-10-21", calls: 0 },
      { date: "2026-10-22", calls: 2 },
      { date: "2026-10-23", calls: 1 },
    ]);
    // until at midnight touches no part of that date.
    expect(await days("2026-10-21T00:00:00Z", "2026-10-23T00:00:00Z")).toEqual([
      { date: "2026-10-21", calls: 0 },
      { date: "2026-10-22", calls: 2 },
    ]);
    expect(
      await days("2026-10-22T02:00:00Z", "2026-10-22T14:00:00Z", {
        kind: "user",
        ownerId: OWNER,
        userId: OTHER,
      }),
    ).toEqual([{ date: "2026-10-22", calls: 0 }]);
  });
});
