import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type {
  BudgetRootKind,
  ConversationCallClass,
  ConversationCallState,
} from "@werft-ai/contracts";
import type {
  UsageBreakdownRecord,
  UsageConversationCostRecord,
  UsageSummaryFilter,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  agents,
  channelContexts,
  conversations,
  users,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresUsageReader } from "./usage-reader.ts";

// The conversation calls beside the sessions on the usage reads (94S-2234):
// settled cost alone, split by class, and the open ones keeping it
// incomplete as an open turn keeps a session's.
describe("conversation call cost on the usage reads", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const elsewhere = randomUUID();
  const me = randomUUID();
  const other = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const agentC = randomUUID();
  // Its one call was released: it never ran, so the agent has no row.
  const agentD = randomUUID();
  const conversationOf = new Map<string, string>();
  const period = {
    since: new Date("2026-10-20T00:00:00.000Z"),
    until: new Date("2026-10-22T00:00:00.000Z"),
  };
  const micro = (usd: string) => Math.round(Number(usd) * 1e6);

  async function call(c: {
    agent: string;
    workspace?: string;
    at: string;
    state: ConversationCallState;
    cls: ConversationCallClass | null;
    cost?: number;
    by?: string | null;
    // A person asked by default, nobody without one.
    root?: BudgetRootKind;
    unknown?: boolean;
  }) {
    const bound = ["in_flight", "settled", "resolved"].includes(c.state);
    const ended = ["settled", "resolved", "released"].includes(c.state);
    const settled = c.state === "settled";
    const at = new Date(c.at).toISOString();
    await db.execute(sql`
      INSERT INTO conversation_calls (id, workspace_id, agent_id, token_hash,
        root_kind, requester_user_id, connection_id, path, model, max_tokens,
        max_request_bytes, state, exchange_id, expires_at, usage, cost_usd,
        tokens, created_at, started_at, ended_at, unknown_at, conversation_id,
        call_class, call_key, attempt)
      VALUES (${randomUUID()}, ${c.workspace ?? ws}, ${c.agent},
        convert_to(${randomUUID()}, 'UTF8'), ${c.root ?? (c.by ? "user" : "none")},
        ${c.by ?? null}, 'conn', '/v1/messages', 'model', 100, 1000,
        ${c.state}, ${bound ? randomUUID() : null},
        ${at}::timestamptz + interval '1 minute',
        ${settled ? sql`'{}'::jsonb` : null}, ${settled ? (c.cost ?? 0) : null},
        ${settled ? 10 : null}, ${at}::timestamptz,
        ${bound ? at : null}::timestamptz, ${ended ? at : null}::timestamptz,
        ${c.unknown ? at : null}::timestamptz,
        ${c.cls ? (conversationOf.get(c.agent) as string) : null}::uuid,
        ${c.cls}, ${c.cls ? `${randomUUID()}:${c.cls}` : null},
        ${c.cls ? 1 : null})`);
  }

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await db.insert(users).values([
      { id: me, email: `me-${me}@example.test`, displayName: "Me" },
      { id: other, email: `o-${other}@example.test`, displayName: "Other" },
    ]);
    for (const [id, agentIds] of [
      [ws, [agentA, agentB, agentD]],
      [elsewhere, [agentC]],
    ] as const) {
      await db
        .insert(workspaces)
        .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "ws" });
      for (const agentId of agentIds) {
        await db.insert(agents).values({
          id: agentId,
          workspaceId: id,
          managingTeamId: await fixtureTeam(db, id),
          slug: `a-${agentId.slice(0, 8)}`,
          name: `agent ${agentId === agentA ? "A" : agentId === agentB ? "B" : "C"}`,
        });
        const conversationId = randomUUID();
        await db.insert(channelContexts).values({
          id: randomUUID(),
          workspaceId: id,
          teamId: "T0ACME",
          channelId: `C${agentId.slice(0, 8)}`,
        });
        await db.insert(conversations).values({
          id: conversationId,
          workspaceId: id,
          agentId,
          kind: "channel",
          teamId: "T0ACME",
          channelId: `C${agentId.slice(0, 8)}`,
        });
        conversationOf.set(agentId, conversationId);
      }
    }
    const day1 = "2026-10-20T09:00:00Z";
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "m1",
      cost: 0.01,
      by: me,
    });
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "m2",
      cost: 0.05,
      by: me,
    });
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "m2",
      cost: 0.02,
      by: other,
    });
    // An allowed Slack bot asked: no person, the agent's side.
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "summary",
      cost: 0.003,
      root: "slack_bot",
    });
    // From an image before the class was recorded, on the person's key.
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: null,
      cost: 0.001,
      by: me,
      root: "key",
    });
    // A key nobody made: a person's side, under no person.
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "m2",
      cost: 0.004,
      root: "key",
    });
    await call({
      agent: agentA,
      at: day1,
      state: "reserved",
      cls: "m1",
      by: me,
    });
    await call({
      agent: agentA,
      at: day1,
      state: "released",
      cls: "m1",
      by: me,
    });
    await call({
      agent: agentB,
      at: day1,
      state: "in_flight",
      cls: "m2",
      by: other,
      unknown: true,
    });
    await call({
      agent: agentB,
      at: day1,
      state: "resolved",
      cls: "m2",
      by: other,
    });
    await call({
      agent: agentB,
      at: "2026-10-21T09:00:00Z",
      state: "settled",
      cls: "m1",
      cost: 0.2,
      by: other,
    });
    await call({
      agent: agentC,
      workspace: elsewhere,
      at: day1,
      state: "settled",
      cls: "m1",
      cost: 5,
      by: me,
    });
    await call({
      agent: agentD,
      at: day1,
      state: "released",
      cls: "m1",
      by: me,
    });
    // Outside the period.
    await call({
      agent: agentA,
      at: "2026-10-25T09:00:00Z",
      state: "settled",
      cls: "m1",
      cost: 9,
      by: me,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  const read = (filter: UsageSummaryFilter) =>
    createPostgresUsageReader(db).usageBreakdown(filter, period, "agent");

  function compact(record: UsageConversationCostRecord | undefined) {
    if (!record) throw new Error("no conversation figures");
    return {
      calls: record.callCount,
      cost: micro(record.costUsd),
      incomplete: record.incompleteCallCount,
      judgment: micro(record.byClass.judgmentUsd),
      turn: micro(record.byClass.turnUsd),
      summary: micro(record.byClass.summaryUsd),
      other: micro(record.byClass.otherUsd),
      person: micro(record.byRequester.personUsd),
      agent: micro(record.byRequester.agentUsd),
    };
  }

  function byKey(record: UsageBreakdownRecord) {
    return record.rows.map((row) => [
      row.key,
      row.sessionCount,
      compact(row.conversation),
    ]);
  }

  test("installation: every agent with calls is a row, largest cost first, settled cost by class", async () => {
    const record = await read({ kind: "installation" });
    expect(byKey(record)).toEqual([
      [
        agentC,
        0,
        {
          calls: 1,
          cost: 5_000_000,
          incomplete: 0,
          judgment: 5_000_000,
          turn: 0,
          summary: 0,
          other: 0,
          person: 5_000_000,
          agent: 0,
        },
      ],
      // In flight with its end unknown, and resolved: no cost, incomplete.
      [
        agentB,
        0,
        {
          calls: 3,
          cost: 200_000,
          incomplete: 2,
          judgment: 200_000,
          turn: 0,
          summary: 0,
          other: 0,
          person: 200_000,
          agent: 0,
        },
      ],
      // Reserved: incomplete; released: never ran, not a call.
      [
        agentA,
        0,
        {
          calls: 7,
          cost: 88_000,
          incomplete: 1,
          judgment: 10_000,
          turn: 74_000,
          summary: 3_000,
          other: 1_000,
          person: 85_000,
          agent: 3_000,
        },
      ],
    ]);
    expect(compact(record.totals.conversation)).toEqual({
      calls: 11,
      cost: 5_288_000,
      incomplete: 3,
      judgment: 5_210_000,
      turn: 74_000,
      summary: 3_000,
      other: 1_000,
      person: 5_285_000,
      agent: 3_000,
    });
    // The sessions' own figures are untouched by the calls.
    expect(record.totals.sessionCount).toBe(0);
    expect(Number(record.totals.costUsd)).toBe(0);
  });

  test("the four classes, and the two requester sides, always add up to the conversation cost", async () => {
    for (const filter of [
      { kind: "installation" },
      { kind: "user", ownerId: ws, userId: me },
      { kind: "user", ownerId: ws, userId: other },
    ] satisfies UsageSummaryFilter[]) {
      const record = await read(filter);
      for (const row of [...record.rows, record.totals]) {
        const figures = compact(row.conversation);
        expect(
          figures.judgment + figures.turn + figures.summary + figures.other,
        ).toBe(figures.cost);
        expect(figures.person + figures.agent).toBe(figures.cost);
      }
    }
  });

  test("scope=me counts the calls asked for by the caller in their workspace; a key's own has none", async () => {
    const mine = await read({ kind: "user", ownerId: ws, userId: me });
    expect(byKey(mine)).toEqual([
      [
        agentA,
        0,
        {
          calls: 4,
          cost: 61_000,
          incomplete: 1,
          judgment: 10_000,
          turn: 50_000,
          summary: 0,
          other: 1_000,
          person: 61_000,
          agent: 0,
        },
      ],
    ]);
    const key = await read({
      kind: "api_key",
      ownerId: ws,
      apiKeyId: randomUUID(),
    });
    expect(key.rows).toEqual([]);
    expect(compact(key.totals.conversation)).toEqual({
      calls: 0,
      cost: 0,
      incomplete: 0,
      judgment: 0,
      turn: 0,
      summary: 0,
      other: 0,
      person: 0,
      agent: 0,
    });
  });

  test("the model breakdown carries no conversation figures", async () => {
    const record = await createPostgresUsageReader(db).usageBreakdown(
      { kind: "installation" },
      period,
      "model",
    );
    expect(record.totals.conversation).toBeUndefined();
  });

  test("the series puts each call's cost on the day it was made, apart from the sessions'", async () => {
    const series = await createPostgresUsageReader(db).usageSeries(
      { kind: "installation" },
      period,
    );
    expect(
      series.buckets.map((b) => [
        b.date,
        micro(b.costUsd),
        micro(b.conversationCostUsd),
        b.conversationIncompleteCallCount,
      ]),
    ).toEqual([
      ["2026-10-20", 0, 5_088_000, 3],
      ["2026-10-21", 0, 200_000, 0],
    ]);
    const breakdown = await read({ kind: "installation" });
    expect(
      series.buckets.reduce((sum, b) => sum + micro(b.conversationCostUsd), 0),
    ).toBe(micro(breakdown.totals.conversation?.costUsd ?? "0"));
  });
  test("people split the person side of the same reach: the workspace's, or one agent's", async () => {
    const reader = createPostgresUsageReader(db);
    const breakdown = await read({ kind: "installation" });
    const row = (agent: string) =>
      breakdown.rows.find((r) => r.key === agent)?.conversation;
    const whole = await reader.usagePeople({ ownerId: ws }, period);
    // Largest first; the key nobody made is the null row.
    expect(
      whole.people.map((p) => [
        p.label,
        p.callCount,
        micro(p.costUsd),
        p.incompleteCallCount,
      ]),
    ).toEqual([
      ["Other", 4, 220_000, 2],
      ["Me", 4, 61_000, 1],
      [null, 1, 4_000, 0],
    ]);
    expect(whole.people[0]?.userId).toBe(other);
    const sideOf = (agents: string[]) =>
      agents.reduce(
        (sum, agent) => sum + micro(row(agent)?.byRequester.personUsd ?? "0"),
        0,
      );
    // agentC is another workspace's: not in this one's people.
    expect(micro(whole.totals.costUsd)).toBe(sideOf([agentA, agentB]));
    expect(whole.people.reduce((sum, p) => sum + micro(p.costUsd), 0)).toBe(
      micro(whole.totals.costUsd),
    );
    expect(whole.totals.callCount).toBe(9);

    const onlyB = await reader.usagePeople(
      { ownerId: ws, agentId: agentB },
      period,
    );
    expect(onlyB.people.map((p) => [p.userId, micro(p.costUsd)])).toEqual([
      [other, 200_000],
    ]);
    expect(micro(onlyB.totals.costUsd)).toBe(sideOf([agentB]));
  });

  test("a period with no person-started call has empty people and zero totals", async () => {
    const empty = await createPostgresUsageReader(db).usagePeople(
      { ownerId: ws },
      {
        since: new Date("2026-09-01T00:00:00.000Z"),
        until: new Date("2026-09-02T00:00:00.000Z"),
      },
    );
    expect(empty.people).toEqual([]);
    expect(empty.totals).toEqual({
      callCount: 0,
      costUsd: "0",
      incompleteCallCount: 0,
    });
  });
});
