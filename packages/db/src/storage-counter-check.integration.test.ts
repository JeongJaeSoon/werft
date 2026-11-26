import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  checkStorageCounter,
  STORAGE_COUNTER_CHECK_LOCK_KEY,
} from "./storage-counter-check.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("the daily storage counter check on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "storage_check_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  test("a replica that finds the check running skips it", async () => {
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1)", [
        STORAGE_COUNTER_CHECK_LOCK_KEY,
      ]);
      expect(await checkStorageCounter(db, { timeoutMs: 60_000 })).toEqual({
        outcome: "busy",
      });
      await other.query("COMMIT");
      expect(await checkStorageCounter(db, { timeoutMs: 60_000 })).toEqual({
        outcome: "checked",
        counterBytes: 0,
        actualBytes: 0,
      });
    } finally {
      other.release();
    }
  });

  test("a scan that runs past its timeout is cancelled by the server", async () => {
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("LOCK TABLE turns IN ACCESS EXCLUSIVE MODE");
      const failure = await checkStorageCounter(db, { timeoutMs: 300 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(findPgError(failure, "57014")).toBeDefined();
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
});
