import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../schema.ts";
import { sessions } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { projectToolCalls } from "./tool-calls.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const toolUse = (id: string) =>
  JSON.stringify({
    type: "assistant",
    tool_call: { id, name: "Bash", input: {} },
  });

integration("tool call projection on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "tool_calls_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE tool_call_days, tool_calls, events, sessions CASCADE`,
    );
    await db.execute(
      sql`UPDATE tool_call_progress SET applied_through = 0 WHERE id = 1`,
    );
    // Events here carry their neutral fields already: the fill has passed them.
    await db.execute(
      sql`UPDATE neutral_field_progress SET filled_through = 9223372036854775807 WHERE id = 1`,
    );
  });

  async function session(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "owner-a",
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
    });
    return id;
  }

  // Session `slow` takes the lower event id in a transaction left open while
  // session `fast` takes the next id and commits: the order a reader that
  // trusted ids alone would skip `slow`'s row in.
  async function inverted() {
    const slow = await session();
    const fast = await session();
    const held = new Client({ connectionString: database.url });
    await held.connect();
    await held.query("BEGIN");
    await held.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
      slow,
    ]);
    await held.query(
      "INSERT INTO events (session_id, type, payload) VALUES ($1, 'tool_use', $2)",
      [slow, toolUse("tu-slow")],
    );
    await pool.query(
      "INSERT INTO events (session_id, type, payload) VALUES ($1, 'tool_use', $2)",
      [fast, toolUse("tu-fast")],
    );
    return {
      commit: async () => {
        await held.query("COMMIT");
        await held.end();
      },
    };
  }

  const calls = async () =>
    rowsOf<{ tool_use_id: string }>(
      await db.execute(
        sql`SELECT tool_use_id FROM tool_calls ORDER BY tool_use_id`,
      ),
    ).map((row) => row.tool_use_id);

  test("a lower id committed after a higher one is still projected within the margin", async () => {
    const { commit } = await inverted();
    const project = () =>
      projectToolCalls(db, {
        batchSize: 100,
        budgetMs: 10_000,
        marginSeconds: 2,
      });
    const during = await project();
    expect(await calls()).toEqual(["tu-fast"]);
    // The committed row is newer than the margin: the cursor stays before it.
    expect(during.appliedThrough).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await commit();
    await project();
    expect(await calls()).toEqual(["tu-fast", "tu-slow"]);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const after = await project();
    expect(after.appliedThrough).toBeGreaterThan(0);
    expect(await calls()).toEqual(["tu-fast", "tu-slow"]);
  }, 20_000);

  // Batches of one put the two rows in separate batches of the same pass.
  test.each([100, 1])(
    "a higher id past the margin does not carry the cursor over a lower one inside it (batches of %d)",
    async (batchSize) => {
      const id = await session();
      const insert = (client: Pick<Client, "query">, toolUseId: string) =>
        client.query(
          "INSERT INTO events (session_id, type, payload) VALUES ($1, 'tool_use', $2)",
          [id, toolUse(toolUseId)],
        );
      // `old` begins first and takes its id last: its row is stamped with the
      // transaction's start, past the margin, above two rows inside it.
      const old = new Client({ connectionString: database.url });
      const open = new Client({ connectionString: database.url });
      await old.connect();
      await open.connect();
      try {
        await old.query("BEGIN");
        await old.query("SELECT now()");
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await insert(pool, "tu-low");
        await open.query("BEGIN");
        await insert(open, "tu-open");
        await insert(old, "tu-high");
        await old.query("COMMIT");
        const project = () =>
          projectToolCalls(db, {
            batchSize,
            budgetMs: 10_000,
            marginSeconds: 1,
          });
        const during = await project();
        expect(await calls()).toEqual(["tu-high", "tu-low"]);
        expect(during.appliedThrough).toBe(0);
        await open.query("COMMIT");
        await project();
        expect(await calls()).toEqual(["tu-high", "tu-low", "tu-open"]);
      } finally {
        // Ending a client rolls back what it left open, which would otherwise
        // hold the next test's TRUNCATE.
        await old.end();
        await open.end();
      }
    },
    20_000,
  );

  test("without the margin the same order loses the row for good", async () => {
    const { commit } = await inverted();
    const project = () =>
      projectToolCalls(db, {
        batchSize: 100,
        budgetMs: 10_000,
        marginSeconds: 0,
      });
    await project();
    await commit();
    await project();
    expect(await calls()).toEqual(["tu-fast"]);
  }, 20_000);
});
