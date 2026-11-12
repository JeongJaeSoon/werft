import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ProviderUsage } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import {
  createProviderExchangeLedger,
  lockProviderExchange,
} from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { attempts, providerExchanges, sessions } from "./schema.ts";

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

  test("an open waits while a report holds the exchange, then sees it settled", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    const report = await held();
    let opening: Promise<unknown> | undefined;
    try {
      await lockProviderExchange(report.asDb, exchangeId);
      opening = createProviderExchangeLedger(db as unknown as Database).open({
        exchangeId,
        ...who,
        reserve: RESERVE,
      });
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
      const opening = createProviderExchangeLedger(
        db as unknown as Database,
      ).open({ exchangeId, ...who, reserve: RESERVE });
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
      const ledger = createProviderExchangeLedger(db as unknown as Database);
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
});
