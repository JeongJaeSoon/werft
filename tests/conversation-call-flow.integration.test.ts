import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isIP } from "node:net";
import {
  type ConversationCallId,
  type ConversationId,
  conversationCallKeySchema,
  conversationIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agents,
  budgetAccounts,
  budgetReservations,
  conversationCalls,
  createPostgresConversationCalls,
  createPostgresWorkerUnitOfWork,
  memberTeams,
  workspaces,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  type BudgetRoot,
  type ConversationCallRequest,
  createConversationCallExecutor,
  createConversationCalls,
  createWorkerGateway,
  type SessionCatalog,
} from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createEgressAuthorizer } from "../apps/control-host/src/api/egress-authorizer.ts";
import { oneHostOutbound } from "../apps/control-host/src/api/outbound-http.ts";
import { wireConversationCallExecutor } from "../apps/control-host/src/wiring/conversation-calls.ts";
import {
  type CredentialProxyServer,
  startCredentialProxy,
} from "../apps/egress-proxy/src/credential.ts";
import { createProxyLogger } from "../apps/egress-proxy/src/logger.ts";

/**
 * A conversation call end to end in one process: the executor reserves on
 * PostgreSQL, the real credential proxy asks the real authorizer for the
 * grant, puts the connection's credential on the call to a fake Messages API
 * and reports what it used, which settles the reservation.
 */

const integration = testDatabaseUrl() ? describe : describe.skip;

const AUTHORIZER_BEARER = ["conversation", "flow", "bearer"].join("-");
const CONNECTION = "claude";
const MODEL = "claude-haiku-4-5";
// The fake answers a request whose prompt says so with this; the rest hang.
const HANG = "hang";
const silent = { warn: () => {} };

integration("conversation call through the egress proxy on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let messages: FakeAnthropicServer;
  let authorizer: ReturnType<typeof Bun.serve>;
  let proxy: CredentialProxyServer;
  let egressUrl: string;
  let catalog: Pick<SessionCatalog, "connections">;
  let workspaceId: string;
  let agentId: string;
  let conversationId: ConversationId;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "conversation_call_flow" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
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
    conversationId = conversationIdSchema.parse(crypto.randomUUID());
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T0FLOW', 'C0FLOW')",
      [crypto.randomUUID(), workspaceId],
    );
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', 'T0FLOW', 'C0FLOW')",
      [conversationId, workspaceId, agentId],
    );

    messages = startFakeAnthropicServer((request) => {
      if (JSON.stringify(request.body.messages).includes(HANG)) {
        return new Promise(() => {});
      }
      return {
        ...textReply("<decision>quiet</decision>"),
        usage: { input_tokens: 120, output_tokens: 8 },
      };
    });
    catalog = {
      connections: {
        [CONNECTION]: {
          provider: {
            kind: "anthropic",
            endpoint: messages.url,
            auth: {
              kind: "api_key",
              value: `catalog-provider-${crypto.randomUUID()}`,
              ref: { stored: `connection:${CONNECTION}` },
            },
          },
          models: [MODEL],
        },
      },
    } as Pick<SessionCatalog, "connections">;
    const gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: { ...(catalog as SessionCatalog), repositories: {} },
      checkpoints: acceptAllCheckpoints,
      conversationCalls: { store: createPostgresConversationCalls(db) },
      options: {
        sessionBudget: { costUsd: 1_000, tokens: null },
        leaseTtlMs: 60_000,
      },
    });
    authorizer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createEgressAuthorizer({
        gateway,
        logger: createLogger({ sinks: [] }),
        token: AUTHORIZER_BEARER,
      }),
    });
    proxy = startCredentialProxy({
      authorizer: {
        url: `http://127.0.0.1:${authorizer.port}`,
        token: AUTHORIZER_BEARER,
      },
      hostname: "127.0.0.1",
      logger: createProxyLogger("error", () => {}),
      policy: {
        allow: [],
        allowPrivate: [
          { host: "127.0.0.1", port: Number(new URL(messages.url).port) },
        ],
      },
      port: 0,
      resolve: async (host) => (isIP(host) !== 0 ? [host] : []),
    });
    egressUrl = `http://127.0.0.1:${proxy.port}`;
  }, 60_000);

  afterAll(async () => {
    proxy?.stop();
    authorizer?.stop(true);
    messages?.stop();
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const call = (
    root: BudgetRoot,
    prompt = "Should the agent answer?",
  ): ConversationCallRequest<string> => ({
    workspaceId,
    agentId,
    conversationId,
    topicId: null,
    // m2, held by no channel's limit: a call left unknown stays in progress.
    callClass: "m2",
    releaseId: null,
    callKey: conversationCallKeySchema.parse(`${crypto.randomUUID()}:m2`),
    attempt: 1,
    root,
    connectionId: CONNECTION,
    model: MODEL,
    maxTokens: 64,
    system: "Answer inside <decision></decision>.",
    messages: [{ role: "user", content: prompt }],
    parse: (text) => /^<decision>(\w+)<\/decision>$/.exec(text)?.[1] ?? null,
  });

  const rowOf = async (callId: ConversationCallId) =>
    (
      await db
        .select()
        .from(conversationCalls)
        .where(eq(conversationCalls.id, callId))
    )[0];
  const reservationOf = async (callId: ConversationCallId) =>
    (
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.callId, callId))
    )[0];

  test("an answered call is issued, granted and settled on one row, and its account holds nothing after", async () => {
    const userId = crypto.randomUUID();
    const executor = wireConversationCallExecutor({
      db,
      catalog,
      egressUrl,
      logger: silent,
    });
    const before = messages.requests.length;
    const result = await executor.run(call({ kind: "user", userId }));
    expect(result).toMatchObject({ outcome: "answered", value: "quiet" });
    if (result.outcome !== "answered") throw new Error(result.outcome);
    expect(messages.requests.length - before).toBe(1);
    // The proxy reports after it answers.
    let row = await rowOf(result.callId);
    for (let tries = 0; row?.state !== "settled" && tries < 100; tries++) {
      await Bun.sleep(50);
      row = await rowOf(result.callId);
    }
    expect(row).toMatchObject({ state: "settled" });
    expect(row?.costUsd).toBeGreaterThan(0);
    expect(await reservationOf(result.callId)).toMatchObject({
      state: "settled",
    });
    const [account] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.ownerId, userId));
    expect(account).toMatchObject({ reservedTokens: 0, reservedCostUsd: 0 });
    expect(account?.spentTokens).toBeGreaterThan(0);
  });

  test("a provider that never answers leaves its call unknown, its reservation held", async () => {
    const executor = createConversationCallExecutor({
      calls: createConversationCalls({
        store: createPostgresConversationCalls(db),
        catalog,
      }),
      egressUrl,
      http: oneHostOutbound(egressUrl, { private: true }),
      logger: silent,
      timeoutMs: 500,
    });
    const result = await executor.run(
      call({ kind: "user", userId: crypto.randomUUID() }, HANG),
    );
    expect(result).toMatchObject({ outcome: "timed_out", retryable: true });
    if (result.outcome !== "timed_out") throw new Error(result.outcome);
    expect(await rowOf(result.callId)).toMatchObject({ state: "in_flight" });
    // Past the provider exchange lease, as the reconciler would find it.
    await db
      .update(conversationCalls)
      .set({ startedAt: sql`now() - interval '1 hour'` })
      .where(eq(conversationCalls.id, result.callId));
    await createPostgresConversationCalls(db).markUnknown({
      limit: 100,
      dryRun: false,
    });
    const row = await rowOf(result.callId);
    expect(row?.state).toBe("in_flight");
    expect(row?.unknownAt).toBeInstanceOf(Date);
    const reservation = await reservationOf(result.callId);
    expect(reservation?.state).toBe("reserved");
    expect(reservation?.unknownAt).toBeInstanceOf(Date);
  });

  test("the agent's own call with no team limit is refused before any provider call, and leaves no row", async () => {
    const executor = wireConversationCallExecutor({
      db,
      catalog,
      egressUrl,
      logger: silent,
    });
    const before = messages.requests.length;
    const [calls] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conversationCalls);
    const [reservations] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(budgetReservations);
    expect(await executor.run(call({ kind: "none" }))).toMatchObject({
      outcome: "refused",
      rootKind: "none",
    });
    expect(messages.requests.length).toBe(before);
    expect(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(conversationCalls),
    ).toEqual([calls as { count: number }]);
    expect(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(budgetReservations),
    ).toEqual([reservations as { count: number }]);
  });
});
