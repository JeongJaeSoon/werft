import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import {
  assertProfileTablesWritable,
  assertReleasesWritable,
  certifyProfiles,
  finalizeCleanup,
  freezeProfiles,
  ProfilesFrozenError,
  readerCertified,
  readFreeze,
  revertReader,
  startCleanup,
  unfreezeProfiles,
} from "./profile-freeze.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("the profile freeze on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "profile_freeze_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  const ok = <T extends { ok: boolean }>(result: T) => {
    expect(result.ok).toBe(true);
    return result as Extract<T, { ok: true }>;
  };

  const refusal = async (promise: Promise<{ ok: boolean }>) => {
    const result = (await promise) as { ok: boolean; reason?: string };
    expect(result.ok).toBe(false);
    return result.reason;
  };

  /** A writer in flight: BEGIN, the barrier first (FOR SHARE), no COMMIT yet. */
  const writerInFlight = async (
    barrier: (tx: Database) => Promise<void>,
  ): Promise<{ client: PoolClient; finish: () => Promise<void> }> => {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await barrier(drizzle(client, { schema }) as unknown as Database);
    } catch (error) {
      await client.query("ROLLBACK");
      client.release();
      throw error;
    }
    return {
      client,
      finish: async () => {
        await client.query("COMMIT");
        client.release();
      },
    };
  };

  const waitForLockWait = async () => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows.length > 0) return;
      await Bun.sleep(20);
    }
    throw new Error("no statement ever waited on a lock");
  };

  test("a new database starts open, with a row, and the reader on the profile path", async () => {
    expect(await readFreeze(db)).toEqual({
      writesFrozen: false,
      reconcileGeneration: 0,
      certifiedGeneration: null,
      phase: "open",
    });
    expect(await readerCertified(db)).toBe(false);
    await assertProfileTablesWritable(db);
    await assertReleasesWritable(db);
  });

  test("freeze, certify, revert and unfreeze move the state one way each", async () => {
    const frozen = ok(await freezeProfiles(db));
    expect(frozen.after).toMatchObject({
      writesFrozen: true,
      reconcileGeneration: 1,
      certifiedGeneration: null,
    });
    expect(await refusal(freezeProfiles(db))).toBe("already_frozen");

    expect(await refusal(certifyProfiles(db, 7))).toBe("generation_mismatch");
    const certified = ok(await certifyProfiles(db, 1));
    expect(certified.after).toMatchObject({
      phase: "certified",
      certifiedGeneration: 1,
    });
    expect(await readerCertified(db)).toBe(true);
    expect(await refusal(unfreezeProfiles(db))).toBe("wrong_phase");

    const reverted = ok(await revertReader(db));
    expect(reverted.after).toMatchObject({
      phase: "open",
      writesFrozen: true,
      certifiedGeneration: null,
      reconcileGeneration: 1,
    });
    expect(await readerCertified(db)).toBe(false);

    const open = ok(await unfreezeProfiles(db));
    expect(open.after).toMatchObject({
      writesFrozen: false,
      reconcileGeneration: 2,
    });
    expect(await refusal(unfreezeProfiles(db))).toBe("not_frozen");
    expect(await refusal(certifyProfiles(db, 2))).toBe("not_frozen");
  });

  test("profile tables stay frozen once certified; releases open again with the pass", async () => {
    ok(await freezeProfiles(db));
    await expect(assertProfileTablesWritable(db)).rejects.toBeInstanceOf(
      ProfilesFrozenError,
    );
    await expect(assertReleasesWritable(db)).rejects.toBeInstanceOf(
      ProfilesFrozenError,
    );
    ok(await certifyProfiles(db, 1));
    await expect(assertProfileTablesWritable(db)).rejects.toBeInstanceOf(
      ProfilesFrozenError,
    );
    await assertReleasesWritable(db);
  });

  test("revert, unfreeze, change, freeze again: releases are blocked until a new pass", async () => {
    ok(await freezeProfiles(db));
    ok(await certifyProfiles(db, 1));
    ok(await revertReader(db));
    ok(await unfreezeProfiles(db));
    ok(await freezeProfiles(db));
    expect((await readFreeze(db))?.reconcileGeneration).toBe(3);
    await expect(assertReleasesWritable(db)).rejects.toBeInstanceOf(
      ProfilesFrozenError,
    );
    // The old pass is for window 1: it cannot be replayed on window 3.
    expect(await refusal(certifyProfiles(db, 1))).toBe("generation_mismatch");
    ok(await certifyProfiles(db, 3));
    await assertReleasesWritable(db);
  });

  test("nothing moves back once cleanup has started", async () => {
    ok(await freezeProfiles(db));
    ok(await certifyProfiles(db, 1));
    ok(await startCleanup(db));
    expect(await refusal(revertReader(db))).toBe("wrong_phase");
    expect(await refusal(unfreezeProfiles(db))).toBe("wrong_phase");
    expect(await refusal(startCleanup(db))).toBe("wrong_phase");
    for (const statement of [
      "UPDATE profile_freeze SET phase = 'open', certified_generation = NULL",
      "UPDATE profile_freeze SET phase = 'certified', cleanup_started_at = NULL",
      "UPDATE profile_freeze SET writes_frozen = false",
      "UPDATE profile_freeze SET reconcile_generation = reconcile_generation + 1, certified_generation = reconcile_generation + 1",
      "DELETE FROM profile_freeze",
      "TRUNCATE profile_freeze",
    ]) {
      await expect(pool.query(statement)).rejects.toThrow();
    }
    ok(await finalizeCleanup(db));
    await expect(
      pool.query("UPDATE profile_freeze SET finalized_at = NULL"),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE profile_freeze SET phase = 'cleanup_started'"),
    ).rejects.toThrow();
    expect((await readFreeze(db))?.phase).toBe("finalized");
  });

  test("the row guards hold against direct SQL before cleanup too", async () => {
    await expect(
      pool.query("UPDATE profile_freeze SET phase = 'cleanup_started'"),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE profile_freeze SET reconcile_generation = -1"),
    ).rejects.toThrow();
    await expect(pool.query("DELETE FROM profile_freeze")).rejects.toThrow();
    await expect(
      pool.query("INSERT INTO profile_freeze (id) VALUES (2)"),
    ).rejects.toThrow();
    ok(await freezeProfiles(db));
    ok(await certifyProfiles(db, 1));
    // A certified window cannot be unfrozen or re-numbered under the pass.
    await expect(
      pool.query("UPDATE profile_freeze SET writes_frozen = false"),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "UPDATE profile_freeze SET reconcile_generation = 2, certified_generation = 2",
      ),
    ).rejects.toThrow();
  });

  test("a missing row fails closed", async () => {
    const client = await pool.connect();
    try {
      // Only a table owner with triggers off can do this; the code must still not read it as open.
      await client.query("SET session_replication_role = replica");
      await client.query("DELETE FROM profile_freeze");
    } finally {
      client.release();
    }
    expect(await readFreeze(db)).toBeNull();
    expect(await readerCertified(db)).toBe(false);
    await expect(assertProfileTablesWritable(db)).rejects.toThrow(/no row/);
    await expect(assertReleasesWritable(db)).rejects.toThrow(/no row/);
    await expect(freezeProfiles(db)).rejects.toThrow(/no row/);
  });

  test("the freezer waits for a writer in flight, then a later writer is refused", async () => {
    const writer = await writerInFlight(assertProfileTablesWritable);
    const freezing = freezeProfiles(db, { lockTimeoutMs: 20_000 });
    await waitForLockWait();
    // The freezer has not changed anything while the writer holds the row.
    expect((await readFreeze(db))?.writesFrozen).toBe(false);
    await writer.finish();
    ok(await freezing);
    await expect(assertProfileTablesWritable(db)).rejects.toBeInstanceOf(
      ProfilesFrozenError,
    );
  });

  test("a freeze that cannot get the row in time changes nothing", async () => {
    const writer = await writerInFlight(assertProfileTablesWritable);
    expect(await refusal(freezeProfiles(db, { lockTimeoutMs: 200 }))).toBe(
      "lock_timeout",
    );
    await writer.finish();
    expect(await readFreeze(db)).toMatchObject({
      writesFrozen: false,
      reconcileGeneration: 0,
    });
    ok(await freezeProfiles(db));
  });

  test("a writer that starts after the freeze commits is refused; one that started first is not lost", async () => {
    ok(await freezeProfiles(db));
    const late = writerInFlight(assertProfileTablesWritable);
    await expect(late).rejects.toBeInstanceOf(ProfilesFrozenError);
    // The refused writer's connection is back in the pool and usable.
    const { rows } = await pool.query("SELECT 1 AS one");
    expect(rows).toEqual([{ one: 1 }]);
  });
});
