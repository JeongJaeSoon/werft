import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  scopesForRole,
  type UsageSeriesResponse,
  type UsageSummaryResponse,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresSessionUnitOfWork,
  createPostgresUsageReader,
  memberships,
  sessions,
  turns,
  users,
  workspaces,
} from "@werft-ai/db";
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
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { fixtureRelease, TEST_MODEL } from "@werft-ai/db/testing/spec-pins";

const integration = testDatabaseUrl() ? describe : describe.skip;

const roomy: InputLimits = {
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes: Number.MAX_SAFE_INTEGER,
};

integration("usage series on PostgreSQL", () => {
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

  function service(on: NodePgDatabase<typeof schema> = db) {
    return createUsageService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(on),
      }),
      reader: createPostgresUsageReader(on),
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
    database = await createTempDatabase({ prefix: "usage_series_it" });
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

  // A session `who` started at `createdAt` with `costUsd` and `tokens`; its
  // one turn takes `turn`, by default a minute that reported its cost.
  async function session(
    who: keyof typeof ids,
    createdAt: string,
    costUsd: number,
    tokens: number,
    turn: Partial<typeof turns.$inferInsert> = {},
  ) {
    const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic(
      {
        limits: roomy,
        principal: user(who, who === "owner" ? "owner" : "member"),
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        agentReleaseId: await fixtureRelease(db),
        model: TEST_MODEL,
        repository: "none",
        message: "count me",
      },
    );
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const id = created.response.session_id;
    const at = new Date(createdAt);
    await db
      .update(sessions)
      .set({ createdAt: at, costUsd, providerTokens: tokens })
      .where(eq(sessions.id, id));
    await db
      .update(turns)
      .set({
        status: "completed",
        startedAt: at,
        endedAt: new Date(at.getTime() + 60_000),
        attemptId: "attempt-1",
        resultJson: { cost_usd: costUsd },
        ...turn,
      })
      .where(and(eq(turns.sessionId, id), eq(turns.sequence, 1)));
    return id;
  }

  async function series(
    caller: Caller,
    query: Record<string, string>,
    on = db,
  ): Promise<UsageSeriesResponse> {
    return usageSeriesResponseSchema.parse(
      await service(on).getUsageSeries(
        caller,
        usageSeriesQuerySchema.parse(query),
      ),
    );
  }

  async function summary(
    caller: Caller,
    query: Record<string, string>,
    on = db,
  ): Promise<UsageSummaryResponse> {
    return usageSummaryResponseSchema.parse(
      await service(on).getUsageSummary(
        caller,
        usageSummaryQuerySchema.parse(query),
      ),
    );
  }

  function totals(response: UsageSeriesResponse) {
    const { buckets } = response;
    return {
      session_count: buckets.reduce((sum, b) => sum + b.session_count, 0),
      // Micro-dollars, the column's scale, so the sum is exact.
      cost_micro_usd: buckets.reduce(
        (sum, b) => sum + Math.round(Number(b.cost_usd) * 1e6),
        0,
      ),
      token_count: buckets.reduce((sum, b) => sum + b.token_count, 0),
      run_seconds: buckets.reduce((sum, b) => sum + b.run_seconds, 0),
      cost_complete: buckets.every((b) => b.cost_complete),
    };
  }

  test("one bucket per UTC day, empty days included, adding up to the summary read at the same moment", async () => {
    const owner = user("owner", "owner");
    await session("alice", "2001-03-01T23:59:59Z", 0.25, 100);
    await session("alice", "2001-03-02T00:00:00Z", 0.5, 200);
    await session("bob", "2001-03-04T10:00:00Z", 4, 4_000);
    // Still running: its time runs up to the read.
    const now = new Date();
    await session("bob", "2001-03-04T11:00:00Z", 1, 10, {
      status: "running",
      startedAt: new Date(now.getTime() - 90_000),
      endedAt: null,
      resultJson: null,
    });
    // Outside the period on both sides.
    await session("alice", "2001-02-28T23:59:59Z", 9, 9);
    await session("alice", "2001-03-05T00:00:00Z", 9, 9);
    const period = { since: "2001-03-01", until: "2001-03-05" };

    // One transaction reads one now(), so the open turn's time is the same
    // moment in both.
    await db.transaction(async (tx) => {
      const on = tx as unknown as NodePgDatabase<typeof schema>;
      const days = await series(
        owner,
        { scope: "installation", ...period },
        on,
      );
      const whole = await summary(
        owner,
        { scope: "installation", ...period },
        on,
      );
      expect(days.period).toEqual(whole.period);
      expect(days.buckets.map((b) => [b.date, b.session_count])).toEqual([
        ["2001-03-01", 1],
        ["2001-03-02", 1],
        ["2001-03-03", 0],
        ["2001-03-04", 2],
      ]);
      expect(days.buckets[2]).toEqual({
        date: "2001-03-03",
        session_count: 0,
        cost_usd: "0",
        cost_complete: true,
        token_count: 0,
        run_seconds: 0,
      });
      expect(totals(days)).toEqual({
        session_count: whole.session_count,
        cost_micro_usd: Math.round(Number(whole.cost_usd) * 1e6),
        token_count: whole.token_count,
        run_seconds: whole.run_seconds,
        cost_complete: whole.cost_complete,
      });
      expect(whole.cost_complete).toBe(false);
    });

    // scope=me adds up the caller's sessions only, as the summary does.
    const mine = await series(user("alice", "member"), {
      scope: "me",
      ...period,
    });
    expect(mine.buckets.map((b) => b.session_count)).toEqual([1, 1, 0, 0]);
    expect(totals(mine)).toMatchObject({
      session_count: (
        await summary(user("alice", "member"), { scope: "me", ...period })
      ).session_count,
      token_count: 300,
    });
  });

  test("run seconds floor the running total, so two 0.6 s days read 0 and 1 as the summary reads 1", async () => {
    for (const day of ["2002-01-01", "2002-01-02"]) {
      const at = new Date(`${day}T12:00:00Z`);
      await session("alice", at.toISOString(), 0.1, 1, {
        startedAt: at,
        endedAt: new Date(at.getTime() + 600),
      });
    }
    const period = { since: "2002-01-01", until: "2002-01-03" };
    const owner = user("owner", "owner");
    const days = await series(owner, { scope: "installation", ...period });
    expect(days.buckets.map((b) => b.run_seconds)).toEqual([0, 1]);
    expect(
      (await summary(owner, { scope: "installation", ...period })).run_seconds,
    ).toBe(1);
  });

  test("a bucket's cost_complete is the summary's over the same sessions", async () => {
    const cases = [
      // Ended without reporting a cost.
      [
        "2003-01-01",
        { status: "failed", resultJson: { error: "boom" } },
        false,
      ],
      // A reported zero is reported.
      ["2003-01-02", { resultJson: { cost_usd: 0 } }, true],
      // Cancelled before it ever ran.
      [
        "2003-01-03",
        {
          status: "cancelled",
          startedAt: null,
          endedAt: null,
          attemptId: null,
          resultJson: null,
        },
        true,
      ],
      // Still running.
      [
        "2003-01-04",
        { status: "running", endedAt: null, resultJson: null },
        false,
      ],
    ] as const;
    for (const [day, turn] of cases) {
      await session("alice", `${day}T08:00:00Z`, 0, 0, turn);
    }
    const owner = user("owner", "owner");
    const days = await series(owner, {
      scope: "installation",
      since: "2003-01-01",
      until: "2003-01-06",
    });
    expect(days.buckets.map((b) => [b.date, b.cost_complete])).toEqual([
      ...cases.map(([day, , complete]) => [day, complete]),
      // A day without sessions.
      ["2003-01-05", true],
    ]);
    for (const [index, bucket] of days.buckets.entries()) {
      const next = new Date(`${bucket.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const one = await summary(owner, {
        scope: "installation",
        since: bucket.date,
        until: next.toISOString().slice(0, 10),
      });
      expect(one.cost_complete, `${index} ${bucket.date}`).toBe(
        bucket.cost_complete,
      );
    }
  });

  test("a since inside a day starts that day's bucket at since", async () => {
    await session("alice", "2004-06-01T05:00:00Z", 1, 1);
    await session("alice", "2004-06-01T15:00:00Z", 2, 2);
    const days = await series(user("owner", "owner"), {
      scope: "installation",
      since: "2004-06-01T12:00:00+09:00",
      until: "2004-06-02",
    });
    // 03:00 UTC: the 05:00 and 15:00 sessions both count, on 06-01.
    expect(days.buckets).toHaveLength(1);
    expect(days.buckets[0]).toMatchObject({
      date: "2004-06-01",
      session_count: 2,
    });
  });

  test("every UTC day has its bucket whatever the database session's time zone", async () => {
    for (const day of ["2026-09-05", "2026-09-06", "2026-09-07"]) {
      await session("alice", `${day}T12:00:00Z`, 1, 1);
    }
    // Santiago skips 2026-09-06 00:00 → 01:00, which once stepped the day
    // series past 09-07's bucket.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'America/Santiago'`);
      const days = await series(
        user("owner", "owner"),
        { scope: "installation", since: "2026-09-05", until: "2026-09-08" },
        tx as unknown as NodePgDatabase<typeof schema>,
      );
      expect(days.buckets.map((b) => [b.date, b.session_count])).toEqual([
        ["2026-09-05", 1],
        ["2026-09-06", 1],
        ["2026-09-07", 1],
      ]);
    });
  });

  test("scope=installation is the signed-in owner's alone", async () => {
    const query = usageSeriesQuerySchema.parse({
      scope: "installation",
      since: "2005-01-01",
      until: "2005-01-02",
    });
    for (const [label, caller] of [
      ["admin", user("admin", "admin")],
      ["member", user("alice", "member")],
      // The role is read again: a token minted as owner does not outlive it.
      ["member claiming owner", user("alice", "owner")],
    ] as const) {
      const error = await service()
        .getUsageSeries(caller, query)
        .catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code, label).toBe("FORBIDDEN");
    }
  });
});
