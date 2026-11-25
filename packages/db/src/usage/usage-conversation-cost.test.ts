import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type {
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
        convert_to(${randomUUID()}, 'UTF8'), ${c.by ? "user" : "none"},
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
    for (const [id, agentIds] of [
      [ws, [agentA, agentB]],
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
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: "summary",
      cost: 0.003,
    });
    // From an image before the class was recorded.
    await call({
      agent: agentA,
      at: day1,
      state: "settled",
      cls: null,
      cost: 0.001,
      by: me,
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
        },
      ],
      // Reserved: incomplete; released: never ran, not a call.
      [
        agentA,
        0,
        {
          calls: 6,
          cost: 84_000,
          incomplete: 1,
          judgment: 10_000,
          turn: 70_000,
          summary: 3_000,
          other: 1_000,
        },
      ],
    ]);
    expect(compact(record.totals.conversation)).toEqual({
      calls: 10,
      cost: 5_284_000,
      incomplete: 3,
      judgment: 5_210_000,
      turn: 70_000,
      summary: 3_000,
      other: 1_000,
    });
    // The sessions' own figures are untouched by the calls.
    expect(record.totals.sessionCount).toBe(0);
    expect(Number(record.totals.costUsd)).toBe(0);
  });

  test("the four classes always add up to the conversation cost", async () => {
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
      ["2026-10-20", 0, 5_084_000, 3],
      ["2026-10-21", 0, 200_000, 0],
    ]);
    const breakdown = await read({ kind: "installation" });
    expect(
      series.buckets.reduce((sum, b) => sum + micro(b.conversationCostUsd), 0),
    ).toBe(micro(breakdown.totals.conversation?.costUsd ?? "0"));
  });
});
