import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "../control-shared.ts";
import * as schema from "../schema.ts";
import { checkpoints, lostCheckpointNotices, sessions } from "../schema.ts";
import {
  forgetLostCheckpointsAtStart,
  hasUncollectedCheckpoint,
} from "./checkpoint-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * forgetLostCheckpointsAtStart beside other connections: the API that gives
 * lost checkpoints up at start is one of several replicas, and the others may
 * be starting too or already serving. PGlite has one connection, so these
 * need PostgreSQL.
 */
integration("giving lost checkpoints up at start, on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "lost_ckpt_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function sessionWithCheckpoint(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "owner-lost",
      repoUrl: "https://example.invalid/app.git",
      branch: `session/${id}`,
      status: "stopped",
      admissionState: "stopped",
      checkpointRevision: 1,
    });
    await db.insert(checkpoints).values({
      sessionId: id,
      revision: 1,
      manifestRef: `s3://claude-sessions/${id}/manifest.json`,
      manifestSha256: "sha256",
    });
    return id;
  }
  const admissionState = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.id, id)))[0]
      ?.admissionState;
  const noticeSessions = async () =>
    (await db.select().from(lostCheckpointNotices)).map((row) =>
      [...row.sessionIds].sort(),
    );
  // Connections of this database waiting for an advisory lock.
  const advisoryWaiters = async () => {
    const result = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    return result.rows[0]?.n ?? 0;
  };

  test("two APIs starting together record the loss once, and a session of the first stays locked through the second look", async () => {
    const lost = await sessionWithCheckpoint();
    let second: ReturnType<typeof forgetLostCheckpointsAtStart> | undefined;
    const first = await forgetLostCheckpointsAtStart(
      db,
      new Date(),
      async () => {
        // The first holds its locks. The second starts on a connection of its
        // own and has to wait for the first instead of reading the same
        // checkpoints: seen in pg_locks, not assumed from a delay.
        second = forgetLostCheckpointsAtStart(db, new Date(), async () => true);
        for (let waited = 0; (await advisoryWaiters()) === 0; waited += 1) {
          if (waited === 200) throw new Error("the second start never waited");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // What a finalize takes first (acquireFence): the session row. It is
        // not available while the bucket is read again.
        const locked = await db
          .execute(
            sql`SELECT id FROM sessions WHERE id = ${lost} FOR UPDATE NOWAIT`,
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(findPgError(locked, "55P03")).toBeDefined();
        return true;
      },
    );
    expect(first).toEqual({ held: [lost], unchanged: [] });
    expect(await second).toEqual({ held: [], unchanged: [] });
    expect(await noticeSessions()).toEqual([[lost]]);
    expect(await admissionState(lost)).toBe("recovery_required");
    await db.delete(lostCheckpointNotices);
  }, 30_000);

  test("a checkpoint another session commits during the second look is not given up", async () => {
    const lost = await sessionWithCheckpoint();
    let written: string | undefined;
    const result = await forgetLostCheckpointsAtStart(
      db,
      new Date(),
      async () => {
        // An API that is already serving commits a checkpoint of a session
        // this start did not lock. The bucket check is the caller's; here it
        // still answers "lost" for the sessions that are locked.
        written = await sessionWithCheckpoint();
        return true;
      },
    );
    expect(result).toEqual({ held: [lost], unchanged: [] });
    expect(written).toBeDefined();
    expect(await admissionState(written as string)).toBe("stopped");
    const kept = await db
      .select({ collectedAt: checkpoints.collectedAt })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, written as string));
    expect(kept).toEqual([{ collectedAt: null }]);
    expect(await noticeSessions()).toEqual([[lost]]);
    // Left for the next test to find: one live checkpoint.
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    await db.delete(lostCheckpointNotices);
  }, 30_000);

  test("a second look that finds the checkpoints again changes nothing", async () => {
    expect(
      await forgetLostCheckpointsAtStart(db, new Date(), async () => false),
    ).toEqual({ held: [], unchanged: [] });
    expect(await hasUncollectedCheckpoint(db)).toBe(true);
    expect(await noticeSessions()).toEqual([]);
  }, 30_000);
});
