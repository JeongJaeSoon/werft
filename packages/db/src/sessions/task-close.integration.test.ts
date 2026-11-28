import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TASK_CLOSING_DEFAULT } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { sessionOutcomes, sessions } from "../schema.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { createPostgresTaskCloses } from "./task-close.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// 94S-2539 (M5): a pull request saved under the session's lock, as saving
// one takes it, is seen by a close that waited on that lock, whatever the
// pass read when it chose the task.
integration("a pull request close's reason on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "task_close_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  // Until another connection waits on a lock, at most five seconds.
  const lockWaited = async () => {
    for (let tries = 0; tries < 100; tries += 1) {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the close never waited on the session");
  };

  test("an open pull request saved while the close waits on the session keeps the task open", async () => {
    const { sessionId, ownerId } = await newPartitionedSession(db, "held");
    await db
      .update(sessions)
      .set({ taskClosing: TASK_CLOSING_DEFAULT })
      .where(eq(sessions.id, sessionId));
    await db.insert(sessionOutcomes).values({
      id: crypto.randomUUID(),
      ownerId,
      sessionId,
      type: "github_pull_request",
      url: "https://github.com/acme/app/pull/1",
      externalId: "1",
      state: "closed",
      stateChangedAt: new Date(),
    });
    // A save of a second pull request, open, holding the session's row.
    const saver = await pool.connect();
    let pass: Promise<number> | undefined;
    try {
      await saver.query("BEGIN");
      await saver.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [
        sessionId,
      ]);
      await saver.query(
        `INSERT INTO session_outcomes
           (id, owner_id, session_id, type, url, external_id, state, state_changed_at)
         VALUES ($1, $2, $3, 'github_pull_request', 'https://github.com/acme/app/pull/2', '2', 'open', now())`,
        [crypto.randomUUID(), ownerId, sessionId],
      );
      // The pass chooses the task on the one closed pull request it sees.
      pass = createPostgresTaskCloses(db).closeOnPullRequests(10);
      await lockWaited();
      await saver.query("COMMIT");
      expect(await pass).toBe(0);
    } finally {
      await saver.query("ROLLBACK").catch(() => undefined);
      saver.release();
      await pass?.catch(() => undefined);
    }
    const [row] = await db
      .select({
        admission: sessions.admissionState,
        reason: sessions.taskClosedReason,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row).toEqual({ admission: "active", reason: null });
  }, 30_000);
});
