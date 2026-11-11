import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrationFile } from "../testing/migrations.ts";

/**
 * The partition backfill, run against the legacy schema:
 * the rows it has to read are launch history the current code no longer
 * consults, so they are written in the old shape and the migration is applied
 * by hand. Found by name so a renumbering restack does not break it.
 */
const migrations = join(import.meta.dir, "../../migrations");

let client: PGlite;
let backfill: string;

const apply = (file: string) => applyMigrationFile(client, file);

async function seedSession(signal?: string): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch) VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2)`,
    [id, `session/${id}`],
  );
  if (signal !== undefined) {
    await client.query(
      `INSERT INTO unassigned_sessions (session_id, partition) VALUES ($1, $2)`,
      [id, signal],
    );
  }
  return id;
}

async function seedLaunch(input: {
  sessionId: string;
  generation: number;
  partition: string;
  leaseEpoch?: number;
  released?: boolean;
}): Promise<void> {
  const executionId = `exec-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
     VALUES ($1, $2, 'local_docker', $3, 'running', 'running')`,
    [executionId, input.sessionId, input.generation],
  );
  let attemptId: string | null = null;
  if (input.leaseEpoch !== undefined) {
    attemptId = `att-${crypto.randomUUID()}`;
    await client.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'exited', now())`,
      [
        attemptId,
        input.sessionId,
        executionId,
        input.leaseEpoch,
        input.generation,
      ],
    );
  }
  await client.query(
    `INSERT INTO worker_launches (execution_id, generation, partition, backend, claimed_attempt_id, slot_released_at)
     VALUES ($1, $2, $3, 'local_docker', $4, $5)`,
    [
      executionId,
      input.generation,
      input.partition,
      attemptId,
      input.released === false ? null : new Date(),
    ],
  );
}

async function partitionOf(sessionId: string) {
  const session = await client.query<{ partition: string }>(
    "SELECT partition FROM sessions WHERE id = $1",
    [sessionId],
  );
  const signal = await client.query<{ partition: string }>(
    "SELECT partition FROM unassigned_sessions WHERE session_id = $1",
    [sessionId],
  );
  return {
    session: session.rows[0]?.partition,
    signal: signal.rows[0]?.partition,
  };
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) => name.endsWith("_session_partition.sql"));
  if (!found) throw new Error("session_partition migration not found");
  backfill = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < backfill)) {
    await apply(file);
  }
});

afterEach(async () => {
  await client.close();
});

describe("session partition backfill", () => {
  test("takes the last claimed launch by lease epoch, not by generation", async () => {
    const session = await seedSession();
    await seedLaunch({
      sessionId: session,
      generation: 5,
      partition: "scheduler",
      leaseEpoch: 1,
    });
    // A pool launch carries whatever generation its backend chose.
    await seedLaunch({
      sessionId: session,
      generation: 0,
      partition: "pool",
      leaseEpoch: 2,
    });

    await apply(backfill);

    expect((await partitionOf(session)).session).toBe("pool");
  });

  test("ranks a reservation never claimed after every claimed launch", async () => {
    const claimed = await seedSession();
    await seedLaunch({
      sessionId: claimed,
      generation: 1,
      partition: "ran-here",
      leaseEpoch: 1,
    });
    await seedLaunch({ sessionId: claimed, generation: 2, partition: "other" });
    const reservedOnly = await seedSession();
    await seedLaunch({
      sessionId: reservedOnly,
      generation: 1,
      partition: "reserved",
    });

    await apply(backfill);

    expect((await partitionOf(claimed)).session).toBe("ran-here");
    expect((await partitionOf(reservedOnly)).session).toBe("reserved");
  });

  test("leaves a session that never ran on default and moves its signal there", async () => {
    const session = await seedSession("signal-only");

    await apply(backfill);

    expect(await partitionOf(session)).toEqual({
      session: "default",
      signal: "default",
    });
  });

  test("moves a waiting signal to the session's partition", async () => {
    const session = await seedSession("default");
    await seedLaunch({
      sessionId: session,
      generation: 1,
      partition: "ran-here",
      leaseEpoch: 1,
    });

    await apply(backfill);

    expect(await partitionOf(session)).toEqual({
      session: "ran-here",
      signal: "ran-here",
    });
  });

  test("stops on a launch still holding its slot in another partition", async () => {
    const session = await seedSession();
    await seedLaunch({
      sessionId: session,
      generation: 1,
      partition: "claimed-here",
      leaseEpoch: 1,
    });
    await seedLaunch({
      sessionId: session,
      generation: 2,
      partition: "reserved-elsewhere",
      released: false,
    });

    await expect(apply(backfill)).rejects.toThrow(/94S-367/);
  });
});
