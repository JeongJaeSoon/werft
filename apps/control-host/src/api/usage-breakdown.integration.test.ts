import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  scopesForRole,
  type UsageBreakdownResponse,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentReleases,
  agents,
  agentVersions,
  createDatabaseIdentityReader,
  createPostgresSessionUnitOfWork,
  createPostgresUsageReader,
  memberships,
  sessionPreMeteringCost,
  sessions,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createUsageService,
  type InputLimits,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { fixtureRelease, TEST_MODEL, releaseSpecColumns, TEST_CONNECTION_ID } from "@werft-ai/db/testing/spec-pins";

const integration = testDatabaseUrl() ? describe : describe.skip;

const roomy: InputLimits = {
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
};

type Call = {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  cacheCreation1h?: number;
  costUsd: number;
};

const micro = (usd: string) => Math.round(Number(usd) * 1e6);

integration("usage breakdown on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = crypto.randomUUID();
  const ids = {
    owner: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    alice: crypto.randomUUID(),
    bob: crypto.randomUUID(),
  };
  const agentX = crypto.randomUUID();
  const agentY = crypto.randomUUID();
  const releaseOf = { [agentX]: "release-x", [agentY]: "release-y" };

  function service() {
    return createUsageService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      reader: createPostgresUsageReader(db),
      limits: {
        executionSlotLimit: 10,
        queuedInputLimitPerSession: 20,
        storageLimitBytes: 1_073_741_824,
        maxTurnSeconds: 3600,
        sessionCostLimitUsd: 2.5,
        sessionTokenLimit: null,
        providerMaxRetries: 2,
      },
    });
  }

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "usage_breakdown_it" });
    pool = new Pool({ connectionString: database.url, max: 5 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    for (const [who, id] of Object.entries(ids)) {
      await db.insert(users).values({
        id,
        email: `${who}@example.com`,
        displayName: who,
      });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role: who === "owner" ? "owner" : who === "admin" ? "admin" : "member",
      });
    }
    for (const [agentId, name] of [
      [agentX, "Checkout fixer"],
      [agentY, "Docs writer"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: name.toLowerCase().replace(" ", "-"),
        name,
      });
      const versionId = crypto.randomUUID();
      await db.insert(agentVersions).values({
        id: versionId,
        agentId,
        versionNo: 1,
        card: {},
        contentSha256: randomBytes(32).toString("hex"),
      });
      await db.insert(agentReleases).values({
        id: releaseOf[agentId] as string,
        agentId,
        versionId,
        cardSha256: "card",
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: [],
      });
    }
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function user(who: keyof typeof ids, role: WorkspaceRole): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids[who],
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  // A session `who` started at `createdAt` under `agent`, charged `costUsd`
  // in all; each call is a metered provider_usage row whose insert trigger
  // counts it, as the proxy's report does. What the calls do not explain is
  // set as migration usage_breakdown_rollup sets it for sessions from before metering.
  async function session(
    who: keyof typeof ids,
    createdAt: string,
    agent: string | null,
    costUsd: number,
    calls: Call[],
  ) {
    const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic(
      {
        limits: roomy,
        principal: user(who, who === "owner" ? "owner" : "member"),
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        agentReleaseId: agent ? (releaseOf[agent] as string) : await fixtureRelease(db),
        model: TEST_MODEL,
        repository: "none",
        message: "count me",
      },
    );
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const id = created.response.session_id;
    await db
      .update(sessions)
      .set({
        createdAt: new Date(createdAt),
        costUsd,
        agentReleaseId: agent ? releaseOf[agent] : null,
      })
      .where(eq(sessions.id, id));
    const unmetered =
      costUsd - calls.reduce((sum, call) => sum + call.costUsd, 0);
    if (unmetered > 0) {
      await db.insert(sessionPreMeteringCost).values({
        sessionId: id,
        sessionCreatedAt: new Date(createdAt),
        costUsd: unmetered,
      });
    }
    if (calls.length === 0) return id;
    const executionId = `exec-${crypto.randomUUID()}`;
    const attemptId = `att-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
       VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
      [executionId, id],
    );
    await pool.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
       VALUES ($1, $2, $3, 1, 1, 1, 'exited', now())`,
      [attemptId, id, executionId],
    );
    for (const call of calls) {
      await pool.query(
        `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated, cost_usd, priced_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, 'table')`,
        [
          crypto.randomUUID(),
          id,
          attemptId,
          call.model,
          call.input,
          call.output,
          call.cacheCreation ?? 0,
          call.cacheCreation1h ?? 0,
          call.cacheRead ?? 0,
          call.costUsd,
        ],
      );
    }
    return id;
  }

  async function breakdown(
    caller: Caller,
    query: Record<string, string>,
  ): Promise<UsageBreakdownResponse> {
    return usageBreakdownResponseSchema.parse(
      await service().getUsageBreakdown(
        caller,
        usageBreakdownQuerySchema.parse(query),
      ),
    );
  }

  async function summary(caller: Caller, query: Record<string, string>) {
    return usageSummaryResponseSchema.parse(
      await service().getUsageSummary(
        caller,
        usageSummaryQuerySchema.parse(query),
      ),
    );
  }

  function compact(response: UsageBreakdownResponse) {
    return response.rows.map((row) => [
      row.label,
      row.session_count,
      row.token_count,
      micro(row.cost_usd),
    ]);
  }

  function columnSums(rows: UsageBreakdownResponse["rows"]) {
    return {
      input_tokens: rows.reduce((sum, r) => sum + r.input_tokens, 0),
      output_tokens: rows.reduce((sum, r) => sum + r.output_tokens, 0),
      cache_read_input_tokens: rows.reduce(
        (sum, r) => sum + r.cache_read_input_tokens,
        0,
      ),
      cache_creation_input_tokens: rows.reduce(
        (sum, r) => sum + r.cache_creation_input_tokens,
        0,
      ),
      token_count: rows.reduce((sum, r) => sum + r.token_count, 0),
      cost_micro_usd: rows.reduce((sum, r) => sum + micro(r.cost_usd), 0),
    };
  }

  test("by model and by agent group the summary's sessions and add up to it", async () => {
    const opus = "claude-opus-5-5";
    const sonnet = "claude-sonnet-5-5";
    // 1-hour cache writes are part of cache_creation, as the proxy clamps them.
    await session("alice", "2010-05-01T09:00:00Z", agentX, 0.4, [
      {
        model: opus,
        input: 100,
        output: 10,
        cacheRead: 5,
        cacheCreation: 3,
        cacheCreation1h: 2,
        costUsd: 0.3,
      },
      { model: sonnet, input: 20, output: 2, costUsd: 0.1 },
    ]);
    await session("bob", "2010-05-01T10:00:00Z", agentY, 0.2, [
      { model: opus, input: 50, output: 5, costUsd: 0.2 },
    ]);
    // Charged before proxy metering: no call explains its cost.
    await session("alice", "2010-05-02T09:00:00Z", null, 0.5, []);
    // Its one call explains 0.05 of 0.15.
    await session("bob", "2010-05-02T10:00:00Z", null, 0.15, [
      { model: sonnet, input: 10, output: 1, costUsd: 0.05 },
    ]);
    // Outside the period.
    await session("alice", "2010-05-03T00:00:00Z", agentX, 9, [
      { model: opus, input: 9, output: 9, costUsd: 9 },
    ]);
    const owner = user("owner", "owner");
    const period = {
      scope: "installation",
      since: "2010-05-01",
      until: "2010-05-03",
    };
    const whole = await summary(owner, period);
    const byModel = await breakdown(owner, { ...period, by: "model" });
    const byAgent = await breakdown(owner, { ...period, by: "agent" });

    expect(compact(byModel)).toEqual([
      [null, 2, 0, 600_000],
      [opus, 2, 173, 500_000],
      [sonnet, 2, 33, 150_000],
    ]);
    expect(byModel.rows.map((r) => r.key)).toEqual([null, opus, sonnet]);
    expect(byModel.rows[1]).toMatchObject({
      input_tokens: 150,
      output_tokens: 15,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    });
    // The rollup the trigger kept reads as the calls themselves do.
    const fromCalls = await pool.query<{
      model: string;
      session_count: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_input_tokens: string;
      cache_creation_input_tokens: string;
      cost_usd: string;
    }>(
      `SELECT pu.model, count(DISTINCT pu.session_id)::text AS session_count,
              sum(pu.input_tokens)::text AS input_tokens,
              sum(pu.output_tokens)::text AS output_tokens,
              sum(pu.cache_read_input_tokens)::text AS cache_read_input_tokens,
              sum(pu.cache_creation_input_tokens)::text AS cache_creation_input_tokens,
              sum(pu.cost_usd)::text AS cost_usd
       FROM provider_usage pu JOIN sessions s ON s.id = pu.session_id
       WHERE s.created_at >= '2010-05-01' AND s.created_at < '2010-05-03'
       GROUP BY pu.model ORDER BY pu.model`,
    );
    expect(
      byModel.rows
        .filter((row) => row.key !== null)
        .map((row) => ({
          model: row.key,
          session_count: String(row.session_count),
          input_tokens: String(row.input_tokens),
          output_tokens: String(row.output_tokens),
          cache_read_input_tokens: String(row.cache_read_input_tokens),
          cache_creation_input_tokens: String(row.cache_creation_input_tokens),
          cost_usd: micro(row.cost_usd),
        }))
        .sort((a, b) => String(a.model).localeCompare(String(b.model))),
    ).toEqual(
      fromCalls.rows.map((row) => ({ ...row, cost_usd: micro(row.cost_usd) })),
    );
    // And so do its sums for the totals and by agent.
    const callSum = (column: keyof (typeof fromCalls.rows)[number]) =>
      fromCalls.rows.reduce((sum, row) => sum + Number(row[column]), 0);
    for (const response of [byModel, byAgent]) {
      expect(response.totals).toMatchObject({
        input_tokens: callSum("input_tokens"),
        output_tokens: callSum("output_tokens"),
        cache_read_input_tokens: callSum("cache_read_input_tokens"),
        cache_creation_input_tokens: callSum("cache_creation_input_tokens"),
      });
    }

    expect(compact(byAgent)).toEqual([
      [null, 2, 11, 650_000],
      ["Checkout fixer", 1, 140, 400_000],
      ["Docs writer", 1, 55, 200_000],
    ]);
    expect(byAgent.rows.map((r) => r.key)).toEqual([null, agentX, agentY]);

    for (const response of [byModel, byAgent]) {
      expect(response.totals).toEqual(byAgent.totals);
      expect({
        session_count: response.totals.session_count,
        token_count: response.totals.token_count,
        cost_micro_usd: micro(response.totals.cost_usd),
      }).toEqual({
        session_count: whole.session_count,
        token_count: whole.token_count,
        cost_micro_usd: micro(whole.cost_usd),
      });
      for (const row of [...response.rows, response.totals]) {
        expect(row.token_count).toBe(
          row.input_tokens +
            row.output_tokens +
            row.cache_read_input_tokens +
            row.cache_creation_input_tokens,
        );
      }
      const { session_count: _, ...figures } = response.totals;
      expect(columnSums(response.rows)).toEqual({
        input_tokens: figures.input_tokens,
        output_tokens: figures.output_tokens,
        cache_read_input_tokens: figures.cache_read_input_tokens,
        cache_creation_input_tokens: figures.cache_creation_input_tokens,
        token_count: figures.token_count,
        cost_micro_usd: micro(figures.cost_usd),
      });
    }
    // Each session sits under one agent, so only those rows add up to it.
    expect(byAgent.rows.reduce((sum, r) => sum + r.session_count, 0)).toBe(
      whole.session_count,
    );

    // scope=me groups the caller's sessions only.
    const mine = await breakdown(user("alice", "member"), {
      scope: "me",
      since: "2010-05-01",
      until: "2010-05-03",
      by: "agent",
    });
    expect(compact(mine)).toEqual([
      [null, 1, 0, 500_000],
      ["Checkout fixer", 1, 140, 400_000],
    ]);
  });

  test("a period without sessions answers no rows and zero totals", async () => {
    for (const by of ["model", "agent"]) {
      const empty = await breakdown(user("owner", "owner"), {
        scope: "installation",
        since: "1999-01-01",
        until: "1999-01-02",
        by,
      });
      expect(empty.rows, by).toEqual([]);
      expect(empty.totals, by).toEqual({
        session_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        token_count: 0,
        cost_usd: "0",
      });
    }
  });

  test("scope=installation is the signed-in owner's alone", async () => {
    const query = usageBreakdownQuerySchema.parse({
      scope: "installation",
      since: "2005-01-01",
      until: "2005-01-02",
      by: "agent",
    });
    for (const [label, caller] of [
      ["admin", user("admin", "admin")],
      ["member", user("alice", "member")],
      ["member claiming owner", user("alice", "owner")],
    ] as const) {
      const error = await service()
        .getUsageBreakdown(caller, query)
        .catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code, label).toBe("FORBIDDEN");
    }
  });
});
