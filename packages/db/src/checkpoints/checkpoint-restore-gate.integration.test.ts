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
import type { PoolClient } from "pg";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;

const SESSION = "11111111-1111-4111-8111-111111111111";

integration("the gate before the profile tables are deleted", () => {
  let database: TempDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "restore_gate" });
    pool = new Pool({ connectionString: database.url, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  // The session row's own columns are not what this test is about.
  const withoutForeignKeys = async <T>(
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      return await run(client);
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
  };

  beforeEach(async () => {
    await withoutForeignKeys(async (client) => {
      await client.query("DELETE FROM checkpoint_restore_check");
      await client.query("DELETE FROM checkpoints");
    });
  });

  const checkpoint = (revision: number, sha = "a", collected = false) =>
    withoutForeignKeys((client) =>
      client.query(
        `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256, collected_at)
         VALUES ($1, $2, $3, $4, ${collected ? "now()" : "NULL"})`,
        [SESSION, revision, `sessions/${SESSION}/${revision}`, sha.repeat(64)],
      ),
    );

  const record = (
    revision: number,
    outcome: "ok" | "mismatch" | "error",
    sha = "a",
    image = "sha256:image",
  ) =>
    withoutForeignKeys((client) =>
      client.query(
        `INSERT INTO checkpoint_restore_check
           (session_id, revision, manifest_sha256, candidates_digest, image_digest, image_runtime, outcome)
         VALUES ($1, $2, $3, $4, $6, '{}'::jsonb, $5)`,
        [SESSION, revision, sha.repeat(64), "c".repeat(64), outcome, image],
      ),
    );

  const gate = (retained: string[] = ["sha256:image"]) =>
    pool.query("SELECT assert_checkpoint_restore_verified($1::text[])", [
      retained,
    ]);

  test("passes when there is nothing to restore", async () => {
    await expect(gate()).resolves.toBeDefined();
  });

  test("stops while a checkpoint has no check, which is how it stops with no record at all", async () => {
    await checkpoint(1);
    await expect(gate()).rejects.toThrow(/1 checkpoint\(s\) without a check/);
  });

  test("passes once every live checkpoint's latest check is ok", async () => {
    await checkpoint(1);
    await checkpoint(2);
    await record(1, "ok");
    await expect(gate()).rejects.toThrow(/1 checkpoint\(s\) without a check/);
    await record(2, "ok");
    await expect(gate()).resolves.toBeDefined();
  });

  test("the latest check decides: a failure after an ok stops it, an ok after a failure lets it go", async () => {
    await checkpoint(1);
    await record(1, "ok");
    await record(1, "mismatch");
    await expect(gate()).rejects.toThrow(/1 with a failed one/);
    await record(1, "ok");
    await expect(gate()).resolves.toBeDefined();
    await record(1, "error");
    await expect(gate()).rejects.toThrow(/1 with a failed one/);
  });

  test("a check of another manifest does not count: a re-pinned checkpoint is unverified", async () => {
    await checkpoint(1, "b");
    await record(1, "ok", "a");
    await expect(gate()).rejects.toThrow(/1 checkpoint\(s\) without a check/);
  });

  test("a collected checkpoint is not restorable and is not asked for", async () => {
    await checkpoint(1, "a", true);
    await expect(gate()).resolves.toBeDefined();
  });

  test("a checkpoint committed after the last run stops it", async () => {
    await checkpoint(1);
    await record(1, "ok");
    await checkpoint(2);
    await expect(gate()).rejects.toThrow(/1 checkpoint\(s\) without a check/);
  });

  test("only the images that stay can vouch: a check by a removed image proves nothing", async () => {
    await checkpoint(1);
    await record(1, "ok", "a", "sha256:removed");
    await expect(gate(["sha256:kept"])).rejects.toThrow(
      /1 checkpoint\(s\) without a check/,
    );
    await record(1, "mismatch", "a", "sha256:kept");
    await expect(gate(["sha256:kept"])).rejects.toThrow(/1 with a failed one/);
    await expect(
      gate(["sha256:kept", "sha256:removed"]),
    ).resolves.toBeDefined();
  });

  test("one retained image that restores it is enough, whatever another says", async () => {
    await checkpoint(1);
    await record(1, "mismatch", "a", "sha256:old");
    await record(1, "ok", "a", "sha256:new");
    await expect(gate(["sha256:old", "sha256:new"])).resolves.toBeDefined();
  });

  test("it refuses to run without naming the images that stay", async () => {
    await expect(gate([])).rejects.toThrow(/images that stay/);
    await expect(
      pool.query("SELECT assert_checkpoint_restore_verified(NULL)"),
    ).rejects.toThrow(/images that stay/);
  });

  test("no checkpoint can commit between the gate and the end of the deleting transaction", async () => {
    await checkpoint(1);
    await record(1, "ok");
    const holder = await pool.connect();
    const writer = new Pool({ connectionString: database.url, max: 1 });
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT assert_checkpoint_restore_verified($1::text[])",
        [["sha256:image"]],
      );
      const blocked = await writer.connect();
      try {
        await blocked.query("SET lock_timeout = '300ms'");
        await blocked.query("SET session_replication_role = replica");
        await expect(
          blocked.query(
            `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256)
             VALUES ($1, 2, 'k', $2)`,
            [SESSION, "d".repeat(64)],
          ),
        ).rejects.toThrow(/lock timeout/);
      } finally {
        blocked.release();
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await writer.end();
    }
  });

  test("the sessions row can carry the reconstructed run configs, empty until then", async () => {
    const { rows } = await pool.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'legacy_runtime_configs'",
    );
    expect(rows).toEqual([
      { column_name: "legacy_runtime_configs", is_nullable: "YES" },
    ]);
  });
});
