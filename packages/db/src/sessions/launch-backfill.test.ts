import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationFile } from "../testing/migrations.ts";

/**
 * The 0007 backfill, run against the schema as it stood at 0006. It is the
 * only part of the launch-registry move that existing rows go through, and
 * the rows it has to carry cannot be produced by the current code — so the
 * fixtures are written in the old shape and the migration is applied by hand.
 */
const migrations = join(import.meta.dir, "../../migrations");
const BACKFILL = "0007_typical_butterfly.sql";

let client: PGlite;

const apply = (file: string) => applyMigrationFile(client, file);

async function seedSession(partition?: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch) VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2)`,
    [id, `session/${id}`],
  );
  if (partition !== undefined) {
    await client.query(
      `INSERT INTO unassigned_sessions (session_id, partition) VALUES ($1, $2)`,
      [id, partition],
    );
  }
  return id;
}

async function seedExecution(input: {
  id: string;
  sessionId: string;
  nonce: string | null;
  observedState?: string;
  desiredState?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state, bootstrap_nonce, launch_operation_id, created_at)
     VALUES ($1, $2, 'local_docker', 1, $3, $4, $5, $6, '2026-09-22T00:00:00Z')`,
    [
      input.id,
      input.sessionId,
      input.desiredState ?? "running",
      input.observedState ?? "running",
      input.nonce,
      input.nonce === null ? null : crypto.randomUUID(),
    ],
  );
}

async function launches(): Promise<
  Array<{
    execution_id: string;
    partition: string;
    session_id: string | null;
    nonce_hash: Uint8Array | null;
    nonce_expires_at: Date | null;
    slot_released_at: Date | null;
  }>
> {
  const result = await client.query<{
    execution_id: string;
    partition: string;
    session_id: string | null;
    nonce_hash: Uint8Array | null;
    nonce_expires_at: Date | null;
    slot_released_at: Date | null;
  }>("SELECT * FROM worker_launches ORDER BY execution_id");
  return result.rows;
}

beforeEach(async () => {
  client = new PGlite();
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql") && name < BACKFILL)
    .sort();
  for (const file of files) await apply(file);
});

afterEach(async () => {
  await client.close();
});

describe("0007 launch backfill", () => {
  test("carries every live execution into the registry, hash only", async () => {
    const session = await seedSession("default");
    await seedExecution({
      id: "exec-live",
      nonce: "plain-abc",
      sessionId: session,
    });

    await apply(BACKFILL);

    const [row] = await launches();
    expect(row?.execution_id).toBe("exec-live");
    expect(row?.session_id).toBe(session);
    expect(row?.nonce_hash).toEqual(
      createHash("sha256").update("plain-abc", "utf8").digest(),
    );
    expect(row?.nonce_expires_at).toEqual(new Date("2026-09-22T00:10:00.000Z"));
    expect(row?.slot_released_at).toBeNull();
    // The plaintext column is gone, so nothing can read it back.
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'executions'",
    );
    expect(columns.rows.map((c) => c.column_name)).not.toContain(
      "bootstrap_nonce",
    );
  });

  test("a pre-intent row still takes its slot, with no credential", async () => {
    const session = await seedSession("default");
    await seedExecution({ id: "exec-legacy", nonce: null, sessionId: session });

    await apply(BACKFILL);

    const [row] = await launches();
    // Without this the scheduler would never see the row, reclaim its
    // container as an orphan and leave the session bound forever.
    expect(row?.execution_id).toBe("exec-legacy");
    expect(row?.nonce_hash).toBeNull();
    expect(row?.nonce_expires_at).toBeNull();
  });

  test("the launch lands in the partition its session is waiting in", async () => {
    const eu = await seedSession("eu-west");
    const unsignalled = await seedSession();
    await seedExecution({ id: "exec-eu", nonce: "n1", sessionId: eu });
    await seedExecution({
      id: "exec-none",
      nonce: "n2",
      sessionId: unsignalled,
    });

    await apply(BACKFILL);

    const rows = await launches();
    expect(rows.map((r) => [r.execution_id, r.partition])).toEqual([
      ["exec-eu", "eu-west"],
      ["exec-none", "default"],
    ]);
  });

  test("executions that no longer hold a slot are left out", async () => {
    const done = await seedSession("default");
    const stopped = await seedSession("default");
    await seedExecution({
      id: "exec-terminated",
      nonce: "n1",
      observedState: "terminated",
      sessionId: done,
    });
    await seedExecution({
      desiredState: "terminated",
      id: "exec-stopping",
      nonce: "n2",
      sessionId: stopped,
    });

    await apply(BACKFILL);

    expect(await launches()).toEqual([]);
  });

  test("an execution the gateway already registered is left alone", async () => {
    const session = await seedSession("default");
    await seedExecution({
      id: "exec-both",
      nonce: "scheduler",
      sessionId: session,
    });
    const theirs = createHash("sha256").update("gateway", "utf8").digest();
    await client.query(
      `INSERT INTO worker_launches (execution_id, generation, partition, session_id, backend, nonce_hash, nonce_expires_at)
       VALUES ('exec-both', 1, 'default', $1, 'local_docker', $2, '2026-09-22T01:00:00Z')`,
      [session, theirs],
    );

    await apply(BACKFILL);

    const [row] = await launches();
    expect(await launches()).toHaveLength(1);
    expect(row?.nonce_hash).toEqual(theirs);
  });
});
