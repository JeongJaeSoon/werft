import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  conversationCallReserve,
  createConversationCalls,
  hashConversationCallToken,
  type ProviderUsage,
  reservationTokens,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { saveBudgetLimit } from "./budget-accounts.ts";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  budgetAccounts,
  budgetReservations,
  conversationCalls,
  memberTeams,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };
const RESERVE = conversationCallReserve(LIMITS);
const CONNECTION = "conn-messages";
const catalog = {
  connections: {
    [CONNECTION]: {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;
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

integration("conversation calls on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  let workspaceId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "conversation_calls_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema }) as NodePgDatabase<
      typeof schema
    > as unknown as Database;
    workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Calls" });
    const teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "team" });
    agentId = crypto.randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: teamId,
      slug: "agent",
      name: "agent",
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresConversationCalls(db);
  async function issued(userId: string = crypto.randomUUID()) {
    const result = await createConversationCalls({
      store: store(),
      catalog,
    }).issue({
      workspaceId,
      agentId,
      root: { kind: "user", userId },
      connectionId: CONNECTION,
      ...LIMITS,
    });
    if (result.outcome !== "issued") throw new Error(result.outcome);
    return result;
  }
  const grant = (token: string, exchangeId: string) =>
    store().authorizeAtomic({
      tokenHash: hashConversationCallToken(token),
      exchangeId,
    });
  const accountOf = async (ownerId: string) =>
    (
      await db
        .select()
        .from(budgetAccounts)
        .where(eq(budgetAccounts.ownerId, ownerId))
    )[0];

  test("eight first grants of one token at once: one exchange is bound", async () => {
    const call = await issued();
    const exchanges = Array.from({ length: 8 }, () => crypto.randomUUID());
    const results = await Promise.all(
      exchanges.map((exchange) => grant(call.token, exchange)),
    );
    const bound = exchanges.filter(
      (_, index) => results[index]?.outcome === "ok",
    );
    expect(bound).toHaveLength(1);
    const [row] = await db
      .select()
      .from(conversationCalls)
      .where(eq(conversationCalls.id, call.callId));
    expect(row?.state).toBe("in_flight");
    expect(row?.exchangeId).toBe(bound[0] as string);
  });

  test("two issues at once on an account that holds one: one token, one refusal, no stray row", async () => {
    const userId = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId },
      { costUsd: null, tokens: RESERVE.tokens * 2 - 1 },
    );
    const results = await Promise.all(
      [0, 1].map(() =>
        createConversationCalls({ store: store(), catalog }).issue({
          workspaceId,
          agentId,
          root: { kind: "user", userId },
          connectionId: CONNECTION,
          ...LIMITS,
        }),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "issued",
      "refused",
    ]);
    expect(await accountOf(userId)).toMatchObject({
      reservedTokens: RESERVE.tokens,
    });
    const rows = await db
      .select({ id: conversationCalls.id })
      .from(conversationCalls)
      .where(eq(conversationCalls.requesterUserId, userId));
    expect(rows).toHaveLength(1);
  });

  test("two reports of one call at once: it is spent once", async () => {
    const userId = crypto.randomUUID();
    const call = await issued(userId);
    const exchange = crypto.randomUUID();
    await grant(call.token, exchange);
    const results = await Promise.all(
      [0, 1].map(() =>
        store().settleAtomic({
          callId: call.callId,
          exchangeId: exchange,
          usage: USED,
          priceFor: () => ({ costUsd: 0.002 }),
        }),
      ),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_settled",
      "settled",
    ]);
    expect(await accountOf(userId)).toMatchObject({
      spentTokens: reservationTokens(USED),
      reservedTokens: 0,
    });
  });

  test("a release and a first grant of an expiring token at once: the call is one or the other, its reservation with it", async () => {
    for (let round = 0; round < 10; round++) {
      const userId = crypto.randomUUID();
      const call = await issued(userId);
      // Expires while the two race: either may see it first.
      await db
        .update(conversationCalls)
        .set({ expiresAt: sql`clock_timestamp() + interval '20 milliseconds'` })
        .where(eq(conversationCalls.id, call.callId));
      await Bun.sleep(15);
      const [, granted] = await Promise.all([
        (async () => {
          await Bun.sleep(5);
          return store().releaseExpired({ limit: 100, dryRun: false });
        })(),
        grant(call.token, crypto.randomUUID()),
      ]);
      // A release that ran too early leaves it for the next pass.
      await Bun.sleep(25);
      await store().releaseExpired({ limit: 100, dryRun: false });
      const [row] = await db
        .select({ state: conversationCalls.state })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, call.callId));
      const [reservation] = await db
        .select({ state: budgetReservations.state })
        .from(budgetReservations)
        .where(eq(budgetReservations.callId, call.callId));
      if (granted.outcome === "ok") {
        expect([row?.state, reservation?.state]).toEqual([
          "in_flight",
          "reserved",
        ]);
        expect(await accountOf(userId)).toMatchObject({
          reservedTokens: RESERVE.tokens,
        });
      } else {
        expect([row?.state, reservation?.state]).toEqual([
          "released",
          "released",
        ]);
        expect(await accountOf(userId)).toMatchObject({ reservedTokens: 0 });
      }
    }
  });
});
