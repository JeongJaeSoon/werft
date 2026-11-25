import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  type BudgetRootKind,
  scopesForRole,
  type UsageBreakdownResponse,
  type UsagePeopleResponse,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usagePeopleQuerySchema,
  usagePeopleResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentAdmins,
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
import {
  fixtureTeam,
  joinFixtureTeam,
} from "@werft-ai/db/testing/fixture-team";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "@werft-ai/db/testing/spec-pins";
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
import { releaseIn } from "../testing/releases.ts";

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
      // Inside the test agents, so a member's start is taken.
      await joinFixtureTeam(db, workspaceId, id);
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
      await db
        .update(agents)
        .set({ activeReleaseId: releaseOf[agentId], activationRevision: 0 })
        .where(eq(agents.id, agentId));
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
        agentReleaseId: agent
          ? (releaseOf[agent] as string)
          : await releaseIn(
              db,
              user(who, who === "owner" ? "owner" : "member").ownerId,
            ),
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

    const { conversation: _talk, ...sessionTotals } = byAgent.totals;
    for (const response of [byModel, byAgent]) {
      const { conversation: _omitted, ...totals } = response.totals;
      expect(totals).toEqual(sessionTotals);
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
        ...(by === "agent"
          ? {
              conversation: {
                call_count: 0,
                cost_usd: "0",
                cost_complete: true,
                by_class: {
                  judgment_usd: "0",
                  turn_usd: "0",
                  summary_usd: "0",
                  other_usd: "0",
                },
                by_requester: { person_usd: "0", agent_usd: "0" },
              },
            }
          : {}),
      });
    }
  });

  // A conversation call (94S-2234) of `agent` asked for by `who`, created at
  // `at`: settled at `costUsd`, or reserved when it has none.
  async function conversationCall(
    agent: string,
    who: keyof typeof ids | null,
    at: string,
    callClass: "m1" | "m2" | "summary",
    costUsd: number | null,
    // Who started the chain; a person when there is one, nobody otherwise.
    root: BudgetRootKind = who ? "user" : "none",
    // A public channel, a private one (Slack's G… ids), or a DM with `who`.
    place: "channel" | "private" | "dm" = "channel",
  ) {
    let conversationId: string | undefined;
    if (place === "dm") {
      const person = ids[who ?? "alice"];
      conversationId = (
        await pool.query<{ id: string }>(
          `INSERT INTO conversations (id, workspace_id, agent_id, kind, person_user_id)
           VALUES ($1, $2, $3, 'dm', $4)
           ON CONFLICT (agent_id, person_user_id) DO UPDATE SET kind = 'dm'
           RETURNING id`,
          [crypto.randomUUID(), workspaceId, agent, person],
        )
      ).rows[0]?.id;
    } else {
      const channel = `${place === "private" ? "G" : "C"}${agent.slice(0, 8)}`;
      await pool.query(
        `INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id)
         VALUES ($1, $2, 'T0ACME', $3) ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), workspaceId, channel],
      );
      const conversation = await pool.query<{ id: string }>(
        `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
         VALUES ($1, $2, $3, 'channel', 'T0ACME', $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [crypto.randomUUID(), workspaceId, agent, channel],
      );
      conversationId =
        conversation.rows[0]?.id ??
        (
          await pool.query<{ id: string }>(
            "SELECT id FROM conversations WHERE agent_id = $1 AND channel_id = $2",
            [agent, channel],
          )
        ).rows[0]?.id;
    }
    const settled = costUsd !== null;
    await pool.query(
      `INSERT INTO conversation_calls (id, workspace_id, agent_id, token_hash,
         root_kind, requester_user_id, connection_id, path, model, max_tokens,
         max_request_bytes, state, exchange_id, expires_at, usage, cost_usd,
         tokens, created_at, started_at, ended_at, conversation_id, call_class,
         call_key, attempt)
       VALUES ($1, $2, $3, convert_to($4, 'UTF8'), $5, $6, 'conn',
         '/v1/messages', 'model', 100, 1000, $7, $8,
         $9::timestamptz + interval '1 minute', $10::jsonb, $11, $12,
         $9::timestamptz, $13::timestamptz, $13::timestamptz, $14, $15, $16, 1)`,
      [
        crypto.randomUUID(),
        workspaceId,
        agent,
        crypto.randomUUID(),
        root,
        who ? ids[who] : null,
        settled ? "settled" : "reserved",
        settled ? crypto.randomUUID() : null,
        at,
        settled ? "{}" : null,
        costUsd,
        settled ? 10 : null,
        settled ? at : null,
        conversationId,
        callClass,
        `${crypto.randomUUID()}:${callClass}`,
      ],
    );
  }

  test("by agent puts each agent's conversation calls beside its sessions, read as the summary is", async () => {
    await session("alice", "2011-06-01T09:00:00Z", agentX, 0.4, []);
    await conversationCall(agentY, "alice", "2011-06-01T10:00:00Z", "m2", 0.5);
    await conversationCall(agentY, "alice", "2011-06-01T10:01:00Z", "m1", null);
    await conversationCall(agentX, "bob", "2011-06-02T09:00:00Z", "m1", 0.01);
    await conversationCall(
      agentX,
      null,
      "2011-06-02T09:30:00Z",
      "summary",
      0.002,
    );
    const period = { since: "2011-06-01", until: "2011-06-03" };
    const owner = user("owner", "owner");
    const whole = await breakdown(owner, {
      scope: "installation",
      ...period,
      by: "agent",
    });
    const talk = (row: UsageBreakdownResponse["rows"][number] | undefined) => [
      row?.label,
      row?.session_count,
      micro(row?.cost_usd ?? "0"),
      row?.conversation?.call_count,
      micro(row?.conversation?.cost_usd ?? "0"),
      row?.conversation?.cost_complete,
      micro(row?.conversation?.by_class.judgment_usd ?? "0"),
      micro(row?.conversation?.by_class.turn_usd ?? "0"),
      micro(row?.conversation?.by_class.summary_usd ?? "0"),
    ];
    // Docs writer has no session but the larger spend, so it comes first.
    expect(whole.rows.map(talk)).toEqual([
      ["Docs writer", 0, 0, 2, 500_000, false, 0, 500_000, 0],
      ["Checkout fixer", 1, 400_000, 2, 12_000, true, 10_000, 0, 2_000],
    ]);
    expect(talk({ ...whole.totals, key: null, label: null })).toEqual([
      null,
      1,
      400_000,
      4,
      512_000,
      false,
      10_000,
      500_000,
      2_000,
    ]);
    // The sessions' own figures stay the summary's.
    const sessionsOnly = await summary(owner, {
      scope: "installation",
      ...period,
    });
    expect(micro(whole.totals.cost_usd)).toBe(micro(sessionsOnly.cost_usd));

    // A member sees only the calls asked for by them.
    const mine = await breakdown(user("alice", "member"), {
      scope: "me",
      ...period,
      by: "agent",
    });
    expect(mine.rows.map(talk)).toEqual([
      ["Docs writer", 0, 0, 2, 500_000, false, 0, 500_000, 0],
      ["Checkout fixer", 1, 400_000, 0, 0, true, 0, 0, 0],
    ]);
    const bobs = await breakdown(user("bob", "member"), {
      scope: "me",
      ...period,
      by: "agent",
    });
    expect(bobs.rows.map(talk)).toEqual([
      ["Checkout fixer", 0, 0, 1, 10_000, true, 10_000, 0, 0],
    ]);
    // An admin reads the whole installation as the owner does.
    expect(
      await breakdown(user("admin", "admin"), {
        scope: "installation",
        ...period,
        by: "agent",
      }),
    ).toEqual(whole);
  });

  test("scope=installation is the signed-in owner's and admins' alone", async () => {
    const query = usageBreakdownQuerySchema.parse({
      scope: "installation",
      since: "2005-01-01",
      until: "2005-01-02",
      by: "agent",
    });
    for (const [label, caller] of [
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
  async function people(caller: Caller, query: Record<string, string>) {
    return usagePeopleResponseSchema.parse(
      await service().getUsagePeople(
        caller,
        usagePeopleQuerySchema.parse(query),
      ),
    );
  }

  // What anyone wrote, under any name a response could carry it by.
  function textKeys(value: unknown, path = ""): string[] {
    if (Array.isArray(value))
      return value.flatMap((item, i) => textKeys(item, `${path}[${i}]`));
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, inner]) => [
      ...(/text|message|body|reply|reason|content|prompt/i.test(key)
        ? [`${path}.${key}`]
        : []),
      ...textKeys(inner, `${path}.${key}`),
    ]);
  }

  test("who started it: person, agent and session parts add up, and people split the person part by reach", async () => {
    const period = { since: "2012-03-01", until: "2012-03-03" };
    const at = (minute: number) =>
      `2012-03-01T10:${String(minute).padStart(2, "0")}:00Z`;
    await session("alice", at(0), agentX, 0.4, []);
    // People: alice in a DM and a public channel, bob in a private channel
    // (and one still open), and a key nobody made.
    await conversationCall(agentX, "alice", at(1), "m2", 0.3, "user", "dm");
    await conversationCall(agentY, "alice", at(2), "m1", 0.05);
    await conversationCall(agentX, "bob", at(3), "m2", 0.2, "user", "private");
    await conversationCall(agentX, "bob", at(4), "m1", null, "user", "private");
    await conversationCall(agentX, null, at(5), "m2", 0.04, "key");
    // The agent's side: its own summary, and an allowed Slack bot's ask.
    await conversationCall(agentY, null, at(6), "summary", 0.01);
    await conversationCall(agentY, null, at(7), "m1", 0.02, "slack_bot");
    // alice manages Docs writer (agentY) alone.
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId: agentY, userId: ids.alice });

    const owner = user("owner", "owner");
    const whole = await breakdown(owner, {
      scope: "installation",
      ...period,
      by: "agent",
    });
    for (const row of [...whole.rows, whole.totals]) {
      const talk = row.conversation;
      if (!talk) throw new Error("no conversation figures");
      expect(
        micro(talk.by_requester.person_usd) +
          micro(talk.by_requester.agent_usd),
      ).toBe(micro(talk.cost_usd));
    }
    const split = whole.totals.conversation?.by_requester;
    // The three parts of the period's spend, each from its own source.
    expect([
      micro(split?.person_usd ?? "0"),
      micro(split?.agent_usd ?? "0"),
      micro(whole.totals.cost_usd),
    ]).toEqual([590_000, 30_000, 400_000]);
    expect(
      micro(split?.person_usd ?? "0") +
        micro(split?.agent_usd ?? "0") +
        micro(whole.totals.cost_usd),
    ).toBe(
      micro(whole.totals.conversation?.cost_usd ?? "0") +
        micro(whole.totals.cost_usd),
    );

    // Owner and admin read every person, the DM's and private channel's
    // calls included; the people add up to the person part.
    const rows = (response: UsagePeopleResponse) =>
      response.people.map((row) => [
        row.label,
        row.call_count,
        micro(row.cost_usd),
        row.cost_complete,
      ]);
    for (const caller of [owner, user("admin", "admin")]) {
      const all = await people(caller, period);
      expect(rows(all)).toEqual([
        ["alice", 2, 350_000, true],
        ["bob", 2, 200_000, false],
        [null, 1, 40_000, true],
      ]);
      expect(all.people[0]?.user_id).toBe(ids.alice);
      expect(micro(all.totals.cost_usd)).toBe(micro(split?.person_usd ?? "0"));
      expect(all.agent_id).toBeNull();
    }

    // An agent's admin reads that agent's share, and nothing wider.
    const docs = whole.rows.find((row) => row.key === agentY);
    const alice = user("alice", "member");
    const mine = await people(alice, { ...period, agent_id: agentY });
    expect(rows(mine)).toEqual([["alice", 1, 50_000, true]]);
    expect(micro(mine.totals.cost_usd)).toBe(
      micro(docs?.conversation?.by_requester.person_usd ?? "0"),
    );
    for (const [label, caller, query] of [
      ["agent admin, another agent", alice, { ...period, agent_id: agentX }],
      ["agent admin, the workspace", alice, period],
      ["member", user("bob", "member"), period],
      [
        "member, an agent",
        user("bob", "member"),
        { ...period, agent_id: agentX },
      ],
    ] as const) {
      const error = await service()
        .getUsagePeople(caller, usagePeopleQuerySchema.parse(query))
        .catch((caught: unknown) => caught);
      expect((error as SessionServiceError).code, label).toBe("FORBIDDEN");
    }
    // A member still reads their own spend with scope=me.
    const bobs = await breakdown(user("bob", "member"), {
      scope: "me",
      ...period,
      by: "agent",
    });
    expect(
      bobs.rows.map((row) => [
        row.label,
        micro(row.conversation?.by_requester.person_usd ?? "0"),
      ]),
    ).toEqual([["Checkout fixer", 200_000]]);

    // No response carries anything anyone wrote.
    expect(textKeys([whole, bobs, mine, await people(owner, period)])).toEqual(
      [],
    );
  });
});
