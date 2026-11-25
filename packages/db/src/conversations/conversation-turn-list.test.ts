import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationTopicId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  INITIATOR_ROOT_KINDS,
} from "@werft-ai/contracts";
import {
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  conversationCallReserve,
  hashConversationCallToken,
  InvalidCursorError,
  type ProviderUsage,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "../budget-accounts.ts";
import { createPostgresConversationCalls } from "../conversation-calls.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { agents, memberTeams } from "../schema.ts";
import { createPostgresConversationTurnListStore } from "./conversation-turn-list.ts";
import { endConversationTurn } from "./conversation-turns.ts";

let client: PGlite;
let db: Database;

const WORKSPACE = "00000000-0000-4000-8000-0000000000d4";
const AGENT = "00000000-0000-4000-8000-0000000001d4";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000002d4";
const USER = "00000000-0000-4000-8000-0000000003d4";
const TEAM = "T0TURNLIST";
const PUBLIC = "C0PUBLIC";
const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the list reads; foreign keys are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const store = () => createPostgresConversationTurnListStore(db);
const read = (
  rootKinds: readonly string[] | null = null,
  cursor?: string,
  limit = 10,
) =>
  store().page({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    rootKinds,
    cursor,
    limit,
  });

async function conversation(agentId: string, channelId: string | null) {
  const id = conversationIdSchema.parse(randomUUID());
  await client.query(
    channelId === null
      ? `INSERT INTO conversations (id, workspace_id, agent_id, kind, person_user_id)
         VALUES ($1, $2, $3, 'dm', $4)`
      : `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
         VALUES ($1, $2, $3, 'channel', $4, $5)`,
    channelId === null
      ? [id, WORKSPACE, agentId, USER]
      : [id, WORKSPACE, agentId, TEAM, channelId],
  );
  return id;
}

let thread = 0;
async function topic(
  agentId: string,
  conversationId: string,
  channelId: string | null,
  kind: "channel" | "dm" = "channel",
): Promise<{ id: ConversationTopicId; ts: string | null }> {
  const id = conversationTopicIdSchema.parse(randomUUID());
  thread += 1;
  const ts =
    channelId === null ? null : `1764000000.${String(thread).padStart(6, "0")}`;
  await client.query(
    `INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id,
      conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts)
     VALUES ($1, $2, $3, $4, $8, $5, $6, $7)`,
    [
      id,
      WORKSPACE,
      agentId,
      conversationId,
      channelId && TEAM,
      channelId,
      ts,
      kind,
    ],
  );
  return { id, ts };
}

/** A turn that ran, written as its rows end up; `at` is its start. */
async function turn(row: {
  conversationId: string;
  topicId: string;
  at: string;
  agentId?: string;
  rootKind?: string;
  requester?: { kind: string; id: string };
  id?: string;
}) {
  const id = row.id ?? randomUUID();
  const requester = row.requester ?? { kind: "user", id: USER };
  await client.query(
    `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id,
      topic_id, origin, state, requester_kind, requester_id, decision,
      created_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'm2', 'decided', $6, $7, 'no_reply',
      $8::timestamptz, $8::timestamptz + interval '5 seconds')`,
    [
      id,
      WORKSPACE,
      row.agentId ?? AGENT,
      row.conversationId,
      row.topicId,
      requester.kind,
      requester.id,
      row.at,
    ],
  );
  await client.query(
    `INSERT INTO conversation_turn_permits (turn_id, token_hash, root_kind,
      requester_user_id, connection_id, path, model, max_tokens,
      max_request_bytes, call_key, expires_at)
     VALUES ($1, $2, $3, NULL, 'conn', '/v1/messages', $4, 256, 4096, $5,
      now())`,
    [
      id,
      Buffer.from(randomUUID()),
      row.rootKind ?? "user",
      MODEL,
      `turn-${id}:m2`,
    ],
  );
  return id;
}

const USED: ProviderUsage = {
  model: MODEL,
  inputTokens: 900,
  outputTokens: 40,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: false,
};

describe("an agent's conversation turns, for its admins", () => {
  test("an operator's turn on the write path shows every field, and no text", async () => {
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId: WORKSPACE, name: "team" });
    await db.insert(agents).values({
      id: AGENT,
      workspaceId: WORKSPACE,
      managingTeamId: teamId,
      slug: "agent",
      name: "agent",
    });
    const reserve = conversationCallReserve(LIMITS);
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId },
      { costUsd: null, tokens: reserve.tokens * 100 },
    );
    const conversationId = await conversation(AGENT, PUBLIC);
    const place = await topic(AGENT, conversationId, PUBLIC);
    const calls = createPostgresConversationCalls(db);
    const turnId = conversationTurnIdSchema.parse(randomUUID());
    const token = [CONVERSATION_TURN_PERMIT_TOKEN_PREFIX, randomUUID()].join(
      "",
    );
    const issued = await calls.issueTurnPermitAtomic({
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      conversationId,
      topicId: place.id,
      requester: { kind: "operator", id: "ops@host" },
      releaseId: null,
      root: { kind: "key", keyKind: "operator", createdByUserId: null },
      connectionId: "conn-messages",
      path: "/v1/messages",
      ...LIMITS,
      callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
      ttlMs: 180_000,
    });
    expect(issued.outcome).toBe("issued");
    // Two calls: one reported and priced, one still in flight.
    const asked = [];
    for (let n = 0; n < 2; n++) {
      const exchangeId = randomUUID();
      const callId = conversationCallIdSchema.parse(randomUUID());
      const granted = await calls.authorizeTurnCallAtomic({
        tokenHash: hashConversationCallToken(token),
        exchangeId,
        callId,
        reserveFor: () => ({ reserve, unmetered: false }),
      });
      expect(granted.outcome).toBe("ok");
      asked.push({ callId, exchangeId });
    }
    const [first] = asked;
    if (!first) throw new Error("no call");
    const settled = await calls.settleAtomic({
      ...first,
      usage: USED,
      priceFor: () => ({ costUsd: 0.0021 }),
    });
    expect(settled.outcome).toBe("settled");
    expect(
      await endConversationTurn(db, {
        turnId,
        end: {
          state: "decided",
          decision: "spawn_task",
          reason: "SECRET REASON",
          answer: null,
        },
      }),
    ).toBe("recorded");
    // The thread's open task session, beside a closed and another agent's.
    const sessionId = randomUUID();
    for (const link of [
      { session: randomUUID(), agent: AGENT, closed: true },
      { session: randomUUID(), agent: OTHER_AGENT, closed: false },
      { session: sessionId, agent: AGENT, closed: false },
    ]) {
      await client.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, session_id,
          installation_id, surface_binding_id, surface_ref, channel_id,
          thread_id, opened_by_ts, agent_id, release_id, closed_at,
          closed_reason)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, 'rel',
          CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN 'completed' END)`,
        [
          randomUUID(),
          WORKSPACE,
          link.session,
          randomUUID(),
          randomUUID(),
          `${PUBLIC}:${place.ts}:${randomUUID()}`,
          PUBLIC,
          place.ts,
          link.agent,
          link.closed,
        ],
      );
    }

    const page = await read();
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item).toMatchObject({
      id: turnId,
      state: "decided",
      limit: null,
      requester: { kind: "operator" },
      decision: "spawn_task",
      models: [MODEL],
      input_tokens: 900,
      output_tokens: 40,
      cost_usd: "0.002100",
      unpriced_calls: 1,
      slack_thread: {
        team_id: TEAM,
        channel_id: PUBLIC,
        thread_ts: place.ts,
        url: `https://slack.com/archives/${PUBLIC}/p${place.ts?.replace(".", "")}`,
      },
      thread_task_session_id: sessionId,
    });
    expect(item?.ended_at).not.toBeNull();
    expect(Date.parse(item?.ended_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(item?.started_at ?? ""),
    );
    expect(JSON.stringify(page)).not.toContain("SECRET REASON");
    expect(JSON.stringify(page)).not.toContain("ops@host");
  });

  test("a mention turn on its write path shows every field: the person who mentioned, the mention's thread, and no text", async () => {
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId: WORKSPACE, name: "team" });
    await db.insert(agents).values({
      id: AGENT,
      workspaceId: WORKSPACE,
      managingTeamId: teamId,
      slug: "agent",
      name: "agent",
    });
    const reserve = conversationCallReserve(LIMITS);
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "person_default" },
      { costUsd: null, tokens: reserve.tokens * 100 },
    );
    const conversationId = await conversation(AGENT, PUBLIC);
    const place = await topic(AGENT, conversationId, PUBLIC);
    const calls = createPostgresConversationCalls(db);
    const turnId = conversationTurnIdSchema.parse(randomUUID());
    const token = [CONVERSATION_TURN_PERMIT_TOKEN_PREFIX, randomUUID()].join(
      "",
    );
    const issued = await calls.issueMentionTurnAtomic({
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      conversationId,
      topicId: place.id,
      requesterUserId: USER,
      slackInstallationId: randomUUID(),
      message: { teamId: TEAM, channelId: PUBLIC, ts: place.ts ?? "" },
      releaseId: null,
      connectionId: "conn-messages",
      path: "/v1/messages",
      ...LIMITS,
      callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
      ttlMs: 180_000,
    });
    expect(issued.outcome).toBe("issued");
    const exchangeId = randomUUID();
    const callId = conversationCallIdSchema.parse(randomUUID());
    const granted = await calls.authorizeTurnCallAtomic({
      tokenHash: hashConversationCallToken(token),
      exchangeId,
      callId,
      reserveFor: () => ({ reserve, unmetered: false }),
    });
    expect(granted.outcome).toBe("ok");
    expect(
      (
        await calls.settleAtomic({
          callId,
          exchangeId,
          usage: USED,
          priceFor: () => ({ costUsd: 0.0021 }),
        })
      ).outcome,
    ).toBe("settled");
    expect(
      await endConversationTurn(db, {
        turnId,
        end: {
          state: "decided",
          decision: "reply",
          reason: "SECRET REASON",
          answer: "SECRET ANSWER",
        },
      }),
    ).toBe("recorded");

    const page = await read();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: turnId,
      state: "decided",
      limit: null,
      requester: { kind: "user", user_id: USER },
      decision: "reply",
      models: [MODEL],
      input_tokens: 900,
      output_tokens: 40,
      cost_usd: "0.002100",
      unpriced_calls: 0,
      slack_thread: {
        team_id: TEAM,
        channel_id: PUBLIC,
        thread_ts: place.ts,
      },
      thread_task_session_id: null,
    });
    expect(page.items[0]?.ended_at).not.toBeNull();
    expect(JSON.stringify(page)).not.toContain("SECRET");
    // A person mentioned: the turn is on the person side of the split.
    expect((await read(INITIATOR_ROOT_KINDS.person)).items).toHaveLength(1);
    expect((await read(INITIATOR_ROOT_KINDS.agent)).items).toHaveLength(0);
  });

  test("pages newest first, ties by id, each turn once across pages", async () => {
    const conversationId = await conversation(AGENT, PUBLIC);
    const place = await topic(AGENT, conversationId, PUBLIC);
    const at = "2026-11-25 10:00:00.123456+00";
    // Three turns at one microsecond and two either side of it.
    const ids = [
      await turn({
        conversationId,
        topicId: place.id,
        at: "2026-11-25 09:00:00+00",
      }),
      ...(await Promise.all(
        [1, 2, 3].map(() => turn({ conversationId, topicId: place.id, at })),
      )),
      await turn({
        conversationId,
        topicId: place.id,
        at: "2026-11-25 11:00:00+00",
      }),
    ];
    const tied = ids.slice(1, 4).sort().reverse();
    const expected = [ids[4], ...tied, ids[0]];
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await read(null, cursor, 2);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(seen).toEqual(expected.map(String));
    expect(pages).toBe(3);
    // The same read again gives the same order.
    const again = await read();
    expect(again.items.map((item): string => item.id)).toEqual(
      expected.map(String),
    );
  });

  test("a cursor it did not mint is refused", async () => {
    await expect(read(null, "bm90LWEtY3Vyc29y")).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  test("every place's turns show, a private channel's and a DM's too, naming only a Werft user and no text", async () => {
    const publicConversation = await conversation(AGENT, PUBLIC);
    const privateConversation = await conversation(AGENT, "G0PRIVATE");
    const dm = await conversation(AGENT, null);
    const other = await conversation(OTHER_AGENT, PUBLIC);
    const publicTopic = await topic(AGENT, publicConversation, PUBLIC);
    const privateTopic = await topic(AGENT, privateConversation, "G0PRIVATE");
    const dmTopic = await topic(AGENT, dm, "D0DIRECT", "dm");
    const webTopic = await topic(AGENT, dm, null, "dm");
    const otherTopic = await topic(OTHER_AGENT, other, PUBLIC);
    const inPublic = await turn({
      conversationId: publicConversation,
      topicId: publicTopic.id,
      at: "2026-11-25 10:00:04+00",
      requester: { kind: "slack_user", id: "U0SECRET" },
    });
    const inPrivate = await turn({
      conversationId: privateConversation,
      topicId: privateTopic.id,
      at: "2026-11-25 10:00:03+00",
    });
    const inDm = await turn({
      conversationId: dm,
      topicId: dmTopic.id,
      at: "2026-11-25 10:00:02+00",
    });
    const onWeb = await turn({
      conversationId: dm,
      topicId: webTopic.id,
      at: "2026-11-25 10:00:01+00",
    });
    // Another agent's turn is not this agent's.
    await turn({
      conversationId: other,
      topicId: otherTopic.id,
      at: "2026-11-25 10:00:00+00",
      agentId: OTHER_AGENT,
    });
    // Bodies a turn row holds, which the list never shows.
    await client.query(
      `UPDATE conversation_turns SET decision = 'reply',
        decision_reason = 'SECRET REASON', answer_text = 'SECRET ANSWER'
       WHERE id = ANY($1::uuid[])`,
      [[inPrivate, inDm]],
    );

    const page = await read();
    expect(page.items.map((item): string => item.id)).toEqual([
      inPublic,
      inPrivate,
      inDm,
      onWeb,
    ]);
    const [publicItem, privateItem, dmItem, webItem] = page.items;
    expect(publicItem?.requester).toEqual({ kind: "slack_user" });
    expect(privateItem).toMatchObject({
      decision: "reply",
      requester: { kind: "user", user_id: USER },
      slack_thread: { channel_id: "G0PRIVATE", thread_ts: privateTopic.ts },
    });
    expect(dmItem).toMatchObject({
      decision: "reply",
      slack_thread: { channel_id: "D0DIRECT", thread_ts: dmTopic.ts },
    });
    expect(webItem?.slack_thread).toBeNull();
    // Metadata only: no field of any item carries a body.
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual([
        "cost_usd",
        "decision",
        "ended_at",
        "id",
        "input_tokens",
        "limit",
        "models",
        "output_tokens",
        "requester",
        "slack_thread",
        "started_at",
        "state",
        "thread_task_session_id",
        "unpriced_calls",
      ]);
    }
    expect(JSON.stringify(page)).not.toContain("SECRET");
  });

  test("sums every settled call, counts the unpriced, leaves released ones out, and names the limit", async () => {
    const conversationId = await conversation(AGENT, PUBLIC);
    const place = await topic(AGENT, conversationId, PUBLIC);
    const turnId = await turn({
      conversationId,
      topicId: place.id,
      at: "2026-11-25 10:00:00+00",
    });
    await client.query(
      `UPDATE conversation_turns SET state = 'no_decision', decision = NULL,
        limit_reached = 'model_call_limit', limit_reached_by = 'server'
       WHERE id = $1`,
      [turnId],
    );
    let attempt = 0;
    const call = async (
      state: "settled" | "released" | "resolved" | "in_flight",
      model: string,
      at: string,
      usage?: { input: number; output: number; cost: string },
    ) => {
      attempt += 1;
      const used = state !== "released";
      const ended =
        state === "settled" || state === "resolved" || state === "released";
      await client.query(
        `INSERT INTO conversation_calls (id, workspace_id, agent_id, token_hash,
          root_kind, connection_id, path, model, max_tokens, max_request_bytes,
          state, exchange_id, expires_at, usage, cost_usd, tokens, created_at,
          started_at, ended_at, conversation_id, call_class, call_key, attempt,
          conversation_turn_id)
         VALUES ($1, $2, $3, $4, 'user', 'conn', '/v1/messages', $5, 256, 4096,
          $6, $7, now(), $8::jsonb, $9::numeric, $10, $11::timestamptz,
          CASE WHEN $12 THEN $11::timestamptz END,
          CASE WHEN $13 THEN $11::timestamptz END, $14, 'm2', $15, $16, $17)`,
        [
          randomUUID(),
          WORKSPACE,
          AGENT,
          Buffer.from(randomUUID()),
          model,
          state,
          used ? randomUUID() : null,
          usage === undefined
            ? null
            : JSON.stringify({
                ...USED,
                model,
                inputTokens: usage.input,
                outputTokens: usage.output,
              }),
          usage?.cost ?? null,
          usage === undefined ? null : usage.input + usage.output,
          at,
          used,
          ended,
          conversationId,
          `turn-${turnId}:m2`,
          attempt,
          turnId,
        ],
      );
    };
    await call("settled", "claude-sonnet-4-5", "2026-11-25 10:00:02+00", {
      input: 100,
      output: 10,
      cost: "0.001000",
    });
    await call("settled", MODEL, "2026-11-25 10:00:01+00", {
      input: 900,
      output: 40,
      cost: "0.002100",
    });
    await call("settled", MODEL, "2026-11-25 10:00:03+00", {
      input: 1,
      output: 2,
      cost: "0.000003",
    });
    await call("resolved", MODEL, "2026-11-25 10:00:04+00");
    await call("in_flight", MODEL, "2026-11-25 10:00:05+00");
    await call("released", "claude-opus-4-5", "2026-11-25 10:00:06+00");
    // The same agent id in another workspace is not this workspace's.
    await client.query(
      `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id,
        topic_id, origin, state, requester_kind, requester_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'm2', 'running', 'user', $6, now())`,
      [randomUUID(), randomUUID(), AGENT, conversationId, place.id, USER],
    );

    const page = await read();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: turnId,
      state: "no_decision",
      decision: null,
      limit: { reached: "model_call_limit", by: "server" },
      models: [MODEL, "claude-sonnet-4-5"],
      input_tokens: 1001,
      output_tokens: 52,
      cost_usd: "0.003103",
      unpriced_calls: 2,
    });
  });

  test("each side of initiator keeps its root kinds, and the two add up to every turn", async () => {
    const conversationId = await conversation(AGENT, PUBLIC);
    const place = await topic(AGENT, conversationId, PUBLIC);
    const byRoot = new Map<string, string>();
    let second = 0;
    for (const rootKind of ["user", "key", "slack_bot", "none"]) {
      second += 1;
      byRoot.set(
        rootKind,
        await turn({
          conversationId,
          topicId: place.id,
          at: `2026-11-25 10:00:0${second}+00`,
          rootKind,
        }),
      );
    }
    const ids = async (rootKinds: readonly string[] | null) =>
      (await read(rootKinds)).items.map((item): string => item.id).sort();
    const of = (...kinds: string[]) =>
      kinds.map((kind) => byRoot.get(kind) ?? "").sort();
    const person = await ids(INITIATOR_ROOT_KINDS.person);
    const agent = await ids(INITIATOR_ROOT_KINDS.agent);
    expect(person).toEqual(of("user", "key"));
    expect(agent).toEqual(of("slack_bot", "none"));
    expect([...person, ...agent].sort()).toEqual(await ids(null));
  });
});
