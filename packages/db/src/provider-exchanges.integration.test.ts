import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type BudgetChoice,
  type HeldSpend,
  type ProviderUsage,
  reservationCostUsd,
  reservationTokens,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { createBudgetLedger, saveBudgetLimit } from "./budget-accounts.ts";
import {
  createProviderExchangeLedger,
  LOCK_SPACE,
  lockProviderExchange,
  lockProviderExchangeSession,
} from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  budgetAccounts,
  providerExchanges,
  sessions,
  workspaces,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const RESERVE: ProviderUsage = {
  model: "gpt-5.5",
  inputTokens: 1_200,
  outputTokens: 32_768,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: true,
};

/** Long enough for a statement that does not wait to have finished. */
const SETTLE_MS = 400;

/** "waited" if `work` has not finished within SETTLE_MS. */
async function waits(work: Promise<unknown>): Promise<"waited" | "done"> {
  return Promise.race([
    work.then(() => "done" as const),
    Bun.sleep(SETTLE_MS).then(() => "waited" as const),
  ]);
}

// What the ledger's open waits on, and what it does not, with real
// connections: the unit tests cover each order one at a time.
integration("the provider exchange ledger under concurrent writers", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "provider_exchanges_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  function ledgerOf(admits: (held: HeldSpend) => boolean = () => true) {
    return createProviderExchangeLedger(db as unknown as Database, {
      admits: async () => admits,
    });
  }

  async function owner() {
    const sessionId = crypto.randomUUID();
    const attemptId = `att-${crypto.randomUUID()}`;
    // The rows are not under test: skip their triggers and foreign keys.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(sessions).values({
        id: sessionId,
        ownerId: "owner-ledger-it",
        repoUrl: "https://github.com/acme/app.git",
        branch: "main",
        repositoryId: "app",
        checkpointRevision: 1,
      });
      await tx.insert(attempts).values({
        id: attemptId,
        sessionId,
        executionId: `exec-${attemptId}`,
        leaseEpoch: 1,
        executionGeneration: 1,
        authRevision: 1,
        state: "running",
        leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
      });
    });
    return { sessionId, attemptId };
  }

  /** A transaction held open on its own connection until `end` is called. */
  async function held(): Promise<{
    run(statement: string, values?: unknown[]): Promise<void>;
    asDb: Database;
    end(): Promise<void>;
  }> {
    const connection: PoolClient = await pool.connect();
    await connection.query("BEGIN");
    return {
      async run(statement, values = []) {
        await connection.query(statement, values);
      },
      asDb: drizzle(connection, { schema }) as unknown as Database,
      async end() {
        await connection.query("COMMIT");
        connection.release();
      },
    };
  }

  /**
   * How many requests for this exchange's lock in this database the server
   * holds back, polled until it reaches `expected` or a few seconds pass.
   */
  async function waitingOnLock(
    exchangeId: string,
    expected: number,
  ): Promise<number> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await pool.query<{ waiting: string }>(
        `SELECT count(*) AS waiting FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = $1::int4::oid AND objid = hashtext($2)::oid AND objsubid = 2`,
        [LOCK_SPACE, exchangeId],
      );
      const waiting = Number(result.rows[0]?.waiting ?? 0);
      if (waiting === expected || Date.now() > deadline) return waiting;
      await Bun.sleep(25);
    }
  }

  test("a usage report waits on the exchange's lock, and an open behind it leaves no row in either order", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    const holder = await held();
    let reporting: Promise<unknown> | undefined;
    let opening: Promise<unknown> | undefined;
    try {
      await lockProviderExchange(holder.asDb, exchangeId);
      // The real report, through recordProviderUsageAtomic.
      reporting = createPostgresWorkerUnitOfWork(
        db as unknown as Database,
      ).recordProviderUsageAtomic({
        exchangeId,
        ...who,
        usage: { ...RESERVE, outputTokens: 80, estimated: false },
        priceFor: () => ({ costUsd: 0.0084, pricedBy: "table" }),
      });
      expect(await waits(reporting)).toBe("waited");
      expect(await waitingOnLock(exchangeId, 1)).toBe(1);
      opening = ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
      expect(await waits(opening)).toBe("waited");
      expect(await waitingOnLock(exchangeId, 2)).toBe(2);
    } finally {
      await holder.end();
    }
    expect(await reporting).toMatchObject({ outcome: "recorded" });
    // Whichever of the two went first, the exchange ends with no row.
    expect(await opening).toMatchObject({
      outcome: expect.stringMatching(/^(settled|created)$/),
    });
    // A report first leaves the open nothing to insert; an open first has
    // its row deleted by the report.
    const left = (await db.select().from(providerExchanges)).filter(
      (row) => row.exchangeId === exchangeId,
    );
    expect(left).toEqual([]);
  }, 20_000);

  test("an open waits while a report holds the exchange, then sees it settled", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    const report = await held();
    let opening: Promise<unknown> | undefined;
    try {
      await lockProviderExchange(report.asDb, exchangeId);
      opening = ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
      expect(await waits(opening)).toBe("waited");
      // The report records its usage, then commits.
      await report.run(
        `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model,
           input_tokens, output_tokens, cache_creation_input_tokens,
           cache_creation_1h_input_tokens, cache_read_input_tokens, estimated,
           cost_usd, priced_by)
         VALUES ($1, $2, $3, 'gpt-5.5', 1200, 80, 0, 0, 0, false, 0.0084, 'table')`,
        [exchangeId, who.sessionId, who.attemptId],
      );
    } finally {
      await report.end();
    }
    expect(await opening).toEqual({ outcome: "settled" });
    const rows = await db.select().from(providerExchanges);
    expect(rows.filter((row) => row.exchangeId === exchangeId)).toEqual([]);
  }, 20_000);

  test("a one-key advisory lock on the same hash does not hold an open up", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    const other = await held();
    // What any other advisory lock in the repository takes: the one-key form.
    await other.run("SELECT pg_advisory_xact_lock(hashtext($1))", [exchangeId]);
    try {
      const opening = ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
      expect(await waits(opening)).toBe("done");
      expect(await opening).toEqual({ outcome: "created" });
    } finally {
      await other.end();
    }
  }, 20_000);

  test("an open does not wait on the session and attempt rows another transaction locks", async () => {
    const who = await owner();
    const fence = await held();
    // As the fence takes them.
    await fence.run(
      "SELECT 1 FROM sessions s JOIN attempts a ON a.session_id = s.id WHERE s.id = $1 AND a.id = $2 FOR UPDATE",
      [who.sessionId, who.attemptId],
    );
    try {
      const ledger = ledgerOf();
      const exchangeId = crypto.randomUUID();
      const opening = ledger.open({ exchangeId, ...who, reserve: RESERVE });
      expect(await waits(opening)).toBe("done");
      expect(await opening).toEqual({ outcome: "created" });
      const renewing = ledger.renew(exchangeId);
      expect(await waits(renewing)).toBe("done");
      expect(await renewing).toBe("open");
    } finally {
      await fence.end();
    }
  }, 20_000);

  test("two opens of one session queue on its lock however its id is spelled, so only one fits a limit of one call", async () => {
    const who = await owner();
    // Room for one reserve: the second open must see the first's row.
    const ledger = ledgerOf((held) => held.reserves.length <= 1);
    const gate = await held();
    let openings: Promise<{ outcome: string }>[] = [];
    try {
      await lockProviderExchangeSession(gate.asDb, who.sessionId);
      openings = [who.sessionId, who.sessionId.toUpperCase()].map((sessionId) =>
        ledger.open({
          exchangeId: crypto.randomUUID(),
          ...who,
          sessionId,
          reserve: RESERVE,
        }),
      );
      for (const opening of openings) {
        expect(await waits(opening)).toBe("waited");
      }
    } finally {
      await gate.end();
    }
    const outcomes = (await Promise.all(openings)).map((one) => one.outcome);
    expect(outcomes.sort()).toEqual(["budget_exceeded", "created"]);
  }, 20_000);

  test("migration 0280 keeps the rows still leased when its transaction began", async () => {
    const who = await owner();
    const migration = await Bun.file(
      new URL(
        "../migrations/0280_provider_exchange_release.sql",
        import.meta.url,
      ),
    ).text();
    const sweep = migration.split("--> statement-breakpoint").at(-1) ?? "";
    expect(sweep).toContain("DELETE");
    const stale = crypto.randomUUID();
    const leased = crypto.randomUUID();
    const migrating = await held();
    try {
      await migrating.asDb.insert(providerExchanges).values([
        {
          exchangeId: stale,
          ...who,
          reserve: RESERVE,
          leaseExpiresAt: sql`now() - interval '1 second'`,
        },
        {
          exchangeId: leased,
          ...who,
          reserve: RESERVE,
          leaseExpiresAt: sql`clock_timestamp() + interval '200 milliseconds'`,
        },
      ]);
      // As if the ALTER waited for its lock past the lease.
      await migrating.run("SELECT pg_sleep(0.4)");
      await migrating.run(sweep);
    } finally {
      await migrating.end();
    }
    const left = (await db.select().from(providerExchanges))
      .map((row) => row.exchangeId)
      .filter((id) => id === stale || id === leased);
    expect(left).toEqual([leased]);
  }, 20_000);

  test("after a report the judge sees its cost and tokens as stored spend, and its row gone", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
    await createPostgresWorkerUnitOfWork(
      db as unknown as Database,
    ).recordProviderUsageAtomic({
      exchangeId,
      ...who,
      usage: { ...RESERVE, outputTokens: 80, estimated: false },
      priceFor: () => ({ costUsd: 0.0084, pricedBy: "table" }),
    });
    let seen: HeldSpend | undefined;
    await ledgerOf((held) => {
      seen = held;
      return true;
    }).open({ exchangeId: crypto.randomUUID(), ...who, reserve: RESERVE });
    expect(seen).toEqual({
      costUsd: 0.0084,
      providerTokens: RESERVE.inputTokens + 80,
      unmetered: false,
      reserves: [RESERVE],
    });
  }, 20_000);
});

integration("a budgeted open under concurrent writers", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTempDatabase({
      prefix: "provider_exchanges_budget_it",
    });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Budget" });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const asDb = () => db as unknown as Database;
  const ledger = () =>
    createProviderExchangeLedger(asDb(), { admits: async () => () => true });

  async function owner() {
    const sessionId = crypto.randomUUID();
    const attemptId = `att-${crypto.randomUUID()}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(sessions).values({
        id: sessionId,
        ownerId: "owner-ledger-budget-it",
        repoUrl: "https://github.com/acme/app.git",
        branch: "main",
        repositoryId: "app",
        checkpointRevision: 1,
        workspaceId,
      });
      await tx.insert(attempts).values({
        id: attemptId,
        sessionId,
        executionId: `exec-${attemptId}`,
        leaseEpoch: 1,
        executionGeneration: 1,
        authRevision: 1,
        state: "running",
        leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
      });
    });
    return { sessionId, attemptId };
  }

  /** A person whose month's account exists, so only its row lock orders opens. */
  async function person(costUsd: number | null) {
    const userId = crypto.randomUUID();
    const budget: BudgetChoice = {
      rootKind: "user",
      owner: { kind: "user", userId },
    };
    if (costUsd !== null) {
      await saveBudgetLimit(
        asDb(),
        workspaceId,
        { kind: "user", userId },
        {
          costUsd,
          tokens: null,
        },
      );
    }
    const warm = await createBudgetLedger(asDb()).reserve({
      callId: `warm-${userId}`,
      workspaceId,
      choice: budget,
      reserve: { costUsd: 0, tokens: 0 },
      unmetered: false,
    });
    if (warm.outcome !== "reserved" || warm.accountId === null) {
      throw new Error(warm.outcome);
    }
    await createBudgetLedger(asDb()).release(`warm-${userId}`);
    return { userId, budget, accountId: warm.accountId };
  }

  async function accountRow(accountId: string) {
    const [row] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.id, accountId as never));
    return row;
  }

  /** A transaction holding one account row, as a reserve in flight does. */
  async function holdingAccount(accountId: string) {
    const connection: PoolClient = await pool.connect();
    await connection.query("BEGIN");
    await connection.query(
      "SELECT 1 FROM budget_accounts WHERE id = $1 FOR UPDATE",
      [accountId],
    );
    return async () => {
      await connection.query("COMMIT");
      connection.release();
    };
  }

  test("opens of two sessions on one account queue on its row, so only one fits its limit", async () => {
    // Room for one reserve, not two.
    const { budget, accountId } = await person(
      reservationCostUsd(RESERVE) * 1.5,
    );
    const sessionsOf = await Promise.all([owner(), owner()]);
    const release = await holdingAccount(accountId);
    let openings: Promise<{ outcome: string }>[] = [];
    try {
      openings = sessionsOf.map((who) =>
        ledger().open({
          exchangeId: crypto.randomUUID(),
          ...who,
          reserve: RESERVE,
          budget,
        }),
      );
      // Each waits on the account row: the session locks are apart.
      for (const opening of openings) {
        expect(await waits(opening)).toBe("waited");
      }
    } finally {
      await release();
    }
    const outcomes = (await Promise.all(openings)).map((one) => one.outcome);
    expect(outcomes.sort()).toEqual(["budget_exceeded", "created"]);
    const account = await accountRow(accountId);
    expect(account?.reservedTokens).toBe(reservationTokens(RESERVE));
    const held = (await db.select().from(providerExchanges)).filter((row) =>
      sessionsOf.some((who) => who.sessionId === row.sessionId),
    );
    expect(held).toHaveLength(1);
  }, 20_000);

  test("a budgeted open does not wait on the session and attempt rows a fence holds", async () => {
    const { budget } = await person(null);
    const who = await owner();
    const connection: PoolClient = await pool.connect();
    await connection.query("BEGIN");
    await connection.query(
      "SELECT 1 FROM sessions s JOIN attempts a ON a.session_id = s.id WHERE s.id = $1 AND a.id = $2 FOR UPDATE",
      [who.sessionId, who.attemptId],
    );
    try {
      const opening = ledger().open({
        exchangeId: crypto.randomUUID(),
        ...who,
        reserve: RESERVE,
        budget,
      });
      expect(await waits(opening)).toBe("done");
      expect(await opening).toEqual({ outcome: "created" });
    } finally {
      await connection.query("COMMIT");
      connection.release();
    }
  }, 20_000);

  test("a report and an open on one account, both waiting on its row, finish without a deadlock", async () => {
    const { budget, accountId } = await person(null);
    const who = await owner();
    const reported = crypto.randomUUID();
    await ledger().open({
      exchangeId: reported,
      ...who,
      reserve: RESERVE,
      budget,
    });
    const release = await holdingAccount(accountId);
    let reporting: Promise<unknown> | undefined;
    let opening: Promise<{ outcome: string }> | undefined;
    try {
      // The report holds the session and attempt rows, then waits on the
      // account; the open of the same session holds its session lock.
      reporting = createPostgresWorkerUnitOfWork(
        asDb(),
      ).recordProviderUsageAtomic({
        exchangeId: reported,
        ...who,
        usage: { ...RESERVE, outputTokens: 80, estimated: false },
        priceFor: () => ({ costUsd: 0.0084, pricedBy: "table" }),
      });
      opening = ledger().open({
        exchangeId: crypto.randomUUID(),
        ...who,
        reserve: RESERVE,
        budget,
      });
      expect(await waits(reporting)).toBe("waited");
      expect(await waits(opening)).toBe("waited");
    } finally {
      await release();
    }
    expect(await reporting).toMatchObject({ outcome: "recorded" });
    expect(await opening).toEqual({ outcome: "created" });
    const account = await accountRow(accountId);
    expect(account).toMatchObject({
      spentCostUsd: 0.0084,
      reservedTokens: reservationTokens(RESERVE),
    });
  }, 20_000);
});
