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

  // A fresh database per test runs every migration; the first can exceed bun's 5s.
  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "profile_freeze_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 60_000);

  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

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
    from: Pool = pool,
  ): Promise<{ client: PoolClient; finish: () => Promise<void> }> => {
    const client = await from.connect();
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

  // The guard's own message, so a CHECK that happens to refuse the same
  // statement cannot stand in for a trigger rule that was dropped.
  const guardRefuses = (statement: string, message: RegExp) =>
    expect(pool.query(statement)).rejects.toThrow(message);

  test("the row guards hold against direct SQL, each by its own rule", async () => {
    await guardRefuses(
      "UPDATE profile_freeze SET reconcile_generation = -1",
      /generation cannot fall|profile_freeze_generation_check/,
    );
    await guardRefuses("DELETE FROM profile_freeze", /cannot be deleted/);
    await guardRefuses(
      "TRUNCATE profile_freeze",
      /cannot be deleted or truncated/,
    );
    await expect(
      pool.query("INSERT INTO profile_freeze (id) VALUES (2)"),
    ).rejects.toThrow(/profile_freeze_single/);
    // Open and unfrozen: a freeze that keeps the generation, or that also certifies.
    await guardRefuses(
      "UPDATE profile_freeze SET writes_frozen = true",
      /must open a new generation/,
    );
    await guardRefuses(
      // One generation up, so only the phase rule is left to refuse it.
      "UPDATE profile_freeze SET writes_frozen = true, phase = 'certified', reconcile_generation = reconcile_generation + 1, certified_generation = reconcile_generation + 1",
      /must open a new generation/,
    );
    await guardRefuses(
      "UPDATE profile_freeze SET reconcile_generation = 5",
      /moves only with a freeze/,
    );
    ok(await freezeProfiles(db));
    // Frozen and uncertified: straight to cleanup would skip the pass.
    await guardRefuses(
      "UPDATE profile_freeze SET phase = 'cleanup_started', certified_generation = reconcile_generation, cleanup_started_at = now()",
      /cannot skip/,
    );
    // Unfreeze and freeze again by hand without a new generation: the replay Codex found.
    await guardRefuses(
      "UPDATE profile_freeze SET writes_frozen = false",
      /must open a new generation/,
    );
    await guardRefuses(
      "UPDATE profile_freeze SET writes_frozen = false, reconcile_generation = reconcile_generation + 2",
      /must open a new generation/,
    );
    ok(await certifyProfiles(db, 1));
    // A certified window cannot be unfrozen or re-numbered under the pass.
    await guardRefuses(
      "UPDATE profile_freeze SET writes_frozen = false, phase = 'open', certified_generation = NULL, reconcile_generation = 2",
      /must open a new generation/,
    );
    await guardRefuses(
      "UPDATE profile_freeze SET reconcile_generation = 2, certified_generation = 2",
      /moves only with a freeze/,
    );
  });

  test("a pass for one window cannot be replayed on a later window with the same number", async () => {
    ok(await freezeProfiles(db));
    // Hand-made: unfreeze and freeze without bumping. Both statements are refused.
    await guardRefuses(
      "UPDATE profile_freeze SET writes_frozen = false",
      /must open a new generation/,
    );
    expect((await readFreeze(db))?.reconcileGeneration).toBe(1);
    ok(await unfreezeProfiles(db));
    ok(await freezeProfiles(db));
    expect(await refusal(certifyProfiles(db, 1))).toBe("generation_mismatch");
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

  test("a writer that starts after the freeze commits is refused and gives its connection back", async () => {
    ok(await freezeProfiles(db));
    // One connection: a leaked one would leave the next query waiting for ever.
    const single = new Pool({
      connectionString: database.url,
      max: 1,
      // A leaked connection must fail the test, not hang the pool's shutdown.
      connectionTimeoutMillis: 2_000,
    });
    try {
      await expect(
        writerInFlight(assertProfileTablesWritable, single),
      ).rejects.toBeInstanceOf(ProfilesFrozenError);
      const { rows } = await Promise.race([
        single.query("SELECT 1 AS one"),
        Bun.sleep(3_000).then(() => {
          throw new Error("the refused writer kept its connection");
        }),
      ]);
      expect(rows).toEqual([{ one: 1 }]);
    } finally {
      await single.end();
    }
  });

  test("a writer in flight is not lost: the freeze waits and the write commits", async () => {
    await pool.query("CREATE TABLE written_by_writer (n integer)");
    const writer = await writerInFlight(assertProfileTablesWritable);
    await writer.client.query("INSERT INTO written_by_writer VALUES (1)");
    const freezing = freezeProfiles(db, { lockTimeoutMs: 20_000 });
    await waitForLockWait();
    // Not committed yet: another connection sees nothing, and the freeze has not happened.
    expect((await pool.query("SELECT n FROM written_by_writer")).rows).toEqual(
      [],
    );
    expect((await readFreeze(db))?.writesFrozen).toBe(false);
    await writer.finish();
    ok(await freezing);
    // After the commit, from a different connection.
    expect((await pool.query("SELECT n FROM written_by_writer")).rows).toEqual([
      { n: 1 },
    ]);
  });
});
