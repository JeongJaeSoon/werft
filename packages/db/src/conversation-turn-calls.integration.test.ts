import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConversationCallId,
  type ConversationTopicId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import {
  type BudgetRoot,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  conversationCallReserve,
  hashConversationCallToken,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { saveBudgetLimit } from "./budget-accounts.ts";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  conversationCalls,
  conversationTurnPermits,
  memberTeams,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LIMITS = {
  model: "claude-haiku-4-5",
  maxTokens: 256,
  maxRequestBytes: 4_096,
};
const RESERVE = conversationCallReserve(LIMITS);

/**
 * A conversation turn's calls asked for at once, as the proxy asks for each
 * of its requests: the call limits and the permit's numbering hold under
 * concurrent grants on real PostgreSQL.
 */
integration("conversation turn calls on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  let workspaceId: string;
  let agentId: string;
  let conversationId: string;
  const TEAM = "T0TURNCALLS";
  const CHANNEL = "C0TURNCALLS";
  let thread = 0;

  beforeAll(async () => {
    database = await createTempDatabase({
      prefix: "conversation_turn_calls_it",
    });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema }) as NodePgDatabase<
      typeof schema
    > as unknown as Database;
    workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Turns" });
    const teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "team" });
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "team", teamId },
      { costUsd: null, tokens: RESERVE.tokens * 1_000 },
    );
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), workspaceId, TEAM, CHANNEL],
    );
    agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: teamId,
      slug: `agent-${agentId}`,
      name: "agent",
    });
    conversationId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
      [conversationId, workspaceId, agentId, TEAM, CHANNEL],
    );
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresConversationCalls(db);

  async function newTopic(): Promise<ConversationTopicId> {
    const id = conversationTopicIdSchema.parse(crypto.randomUUID());
    thread += 1;
    await pool.query(
      "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
      [
        id,
        workspaceId,
        agentId,
        conversationId,
        TEAM,
        CHANNEL,
        `200.${String(thread).padStart(6, "0")}`,
      ],
    );
    return id;
  }

  async function permit(root: BudgetRoot, topicId: ConversationTopicId) {
    const turnId = conversationTurnIdSchema.parse(crypto.randomUUID());
    const token = [
      CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
      crypto.randomUUID(),
    ].join("");
    const issued = await store().issueTurnPermitAtomic({
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId,
      agentId,
      conversationId: conversationIdSchema.parse(conversationId),
      topicId,
      requester:
        root.kind === "user"
          ? { kind: "user", id: root.userId }
          : { kind: "operator", id: "ops@host" },
      releaseId: null,
      root,
      connectionId: "conn-messages",
      path: "/v1/messages",
      ...LIMITS,
      callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
      ttlMs: 180_000,
    });
    if (issued.outcome !== "issued") throw new Error(issued.outcome);
    return { turnId, token };
  }

  const ask = (
    token: string,
    callId: ConversationCallId = conversationCallIdSchema.parse(
      crypto.randomUUID(),
    ),
  ) =>
    store().authorizeTurnCallAtomic({
      tokenHash: hashConversationCallToken(token),
      exchangeId: crypto.randomUUID(),
      callId,
      reserveFor: () => ({ reserve: RESERVE, unmetered: false }),
    });

  const operator: BudgetRoot = {
    kind: "key",
    keyKind: "operator",
    createdByUserId: null,
  };

  test("two turns' calls on one topic at once: one is granted, the other refused by the topic's limit", async () => {
    const topic = await newTopic();
    const [a, b] = await Promise.all([
      permit(operator, topic),
      permit(operator, topic),
    ]);
    const outcomes = await Promise.all([ask(a.token), ask(b.token)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual([
      "concurrency_limited",
      "ok",
    ]);
    const limited = outcomes.find((o) => o.outcome === "concurrency_limited");
    expect(limited).toMatchObject({ limit: "topic", inProgress: 1 });
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.topicId, topic));
    expect(rows).toHaveLength(1);
  });

  test("eight calls of one turn at once: one is granted and numbered, the rest refused with nothing held", async () => {
    const turn = await permit(operator, await newTopic());
    const ids = Array.from({ length: 8 }, () =>
      conversationCallIdSchema.parse(crypto.randomUUID()),
    );
    const outcomes = await Promise.all(ids.map((id) => ask(turn.token, id)));
    expect(outcomes.filter((o) => o.outcome === "ok")).toHaveLength(1);
    expect(
      outcomes.filter((o) => o.outcome === "concurrency_limited"),
    ).toHaveLength(7);
    const rows = await db
      .select()
      .from(conversationCalls)
      .where(eq(conversationCalls.conversationTurnId, turn.turnId));
    expect(rows.map((row) => row.attempt)).toEqual([1]);
    const [kept] = await db
      .select()
      .from(conversationTurnPermits)
      .where(eq(conversationTurnPermits.turnId, turn.turnId));
    expect(kept).toMatchObject({ calls: 1, refusal: "concurrency" });
    const held = await pool.query(
      "SELECT count(*)::int AS n FROM budget_reservations WHERE call_id = ANY($1::text[])",
      [ids],
    );
    expect(held.rows[0]?.n).toBe(1);
  });

  test("a person's five calls at once, each on a topic of its own: four are granted, the fifth refused by the person's limit", async () => {
    const userId = crypto.randomUUID();
    const turns = [];
    for (let n = 0; n < 5; n++) {
      turns.push(await permit({ kind: "user", userId }, await newTopic()));
    }
    const outcomes = await Promise.all(turns.map((turn) => ask(turn.token)));
    expect(outcomes.filter((o) => o.outcome === "ok")).toHaveLength(4);
    const limited = outcomes.filter((o) => o.outcome === "concurrency_limited");
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ limit: "requester", inProgress: 4 });
    const open = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_calls WHERE requester_user_id = $1 AND state = 'in_flight'",
      [userId],
    );
    expect(open.rows[0]?.n).toBe(4);
  });
});
