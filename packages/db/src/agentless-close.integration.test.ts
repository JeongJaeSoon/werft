import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import { closeAgentlessSessions } from "./sessions/agentless-close.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * The cleanup takes a bound session's launch before the session, as the
 * worker's gone observation does, so the two wait on each other in line
 * instead of deadlocking.
 */
integration("closeAgentlessSessions on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agentless_close_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("a writer holding the launch and then taking the session does not deadlock with it", async () => {
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const executionId = `exec-${randomUUID()}`;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $2)",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, status)
       VALUES ($1, 'owner', 'https://example.invalid/repo.git', $2, $3, 'running')`,
      [sessionId, `session/${sessionId}`, workspaceId],
    );
    await pool.query(
      "INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state) VALUES ($1, $2, 'docker', 1, 'running', 'running')",
      [executionId, sessionId],
    );
    await pool.query(
      "INSERT INTO worker_launches (execution_id, session_id, generation, backend) VALUES ($1, $2, 1, 'docker')",
      [executionId, sessionId],
    );
    await pool.query("UPDATE sessions SET execution_id = $1 WHERE id = $2", [
      executionId,
      sessionId,
    ]);

    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
        [executionId],
      );
      const cleanup = closeAgentlessSessions(db);
      // Long enough for the cleanup to reach the lock it waits on.
      await Bun.sleep(300);
      await other.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [
        sessionId,
      ]);
      await other.query("COMMIT");

      expect(await cleanup).toEqual({ closed: [sessionId], failed: [] });
    } finally {
      other.release();
    }
    const { rows } = await pool.query(
      "SELECT admission_state FROM sessions WHERE id = $1",
      [sessionId],
    );
    expect(rows).toEqual([{ admission_state: "closed" }]);
  });
});
