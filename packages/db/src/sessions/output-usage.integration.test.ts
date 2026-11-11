import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresCheckpointStore } from "../checkpoints/checkpoint-store.ts";
import * as schema from "../schema.ts";
import { attempts, checkpoints, sessions } from "../schema.ts";
import { commitCheckpoint } from "../testing/checkpoints.ts";
import { createPostgresUsageReader } from "../usage-reader.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * GET /v1/limits' `usage.outputs`, read off checkpoint_outputs: what
 * finalize recorded for each committed revision, less what checkpoint
 * garbage collection released. Its own database, since the figure is summed
 * over the whole installation.
 */
integration("installation output usage on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "output_usage_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function claimedSession() {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      branch: `session/${sessionId}`,
      id: sessionId,
      ownerId: "owner-outputs",
      repoUrl: "https://example.invalid/app.git",
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
    });
    const attemptId = `attempt-${crypto.randomUUID()}`;
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: 1,
      executionId: `exec-${attemptId}`,
      id: attemptId,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 600_000),
      sessionId,
      state: "running",
    });
    const fence = {
      attemptId,
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
      sessionId,
    };
    const commit = async (
      revision: number,
      outputs?: { key: string; bytes: number }[],
    ) => {
      const result = await commitCheckpoint(db, {
        checkpoint: {
          revision,
          manifest_ref: `sessions/${sessionId}/checkpoints/${revision}/${attemptId}/manifest.json`,
          manifest_sha256: "a".repeat(64),
        },
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
        ...(outputs === undefined ? {} : { outputs }),
      });
      expect(result).toEqual({ outcome: "committed", revision });
    };
    const key = (revision: number, digest: string) =>
      `sessions/${sessionId}/checkpoints/${revision}/${attemptId}/outputs/${digest}`;
    return { sessionId, commit, key };
  }

  const usage = () => createPostgresUsageReader(db).installationUsage();

  test("counts each kept output object once and gives back what collection released", async () => {
    const empty = await usage();
    expect(empty).toMatchObject({
      outputsUsedBytes: 0,
      outputsUpdatedAt: null,
      outputsComplete: true,
    });

    const { sessionId, commit, key } = await claimedSession();
    // Revision 0 uploads a and b; revision 1 keeps a (same ref, inherited),
    // drops b and uploads c. The verifier has already left out a file too
    // large to upload, so it never reaches these rows.
    await commit(0, [
      { key: key(0, "a"), bytes: 100 },
      { key: key(0, "b"), bytes: 50 },
    ]);
    const first = await usage();
    expect(first.outputsUsedBytes).toBe(150);
    expect(first.outputsUpdatedAt).not.toBeNull();

    await commit(1, [
      { key: key(0, "a"), bytes: 100 },
      { key: key(1, "c"), bytes: 30 },
    ]);
    const second = await usage();
    expect(second.outputsUsedBytes).toBe(180);
    expect(second.outputsComplete).toBe(true);
    // Input-message storage and its enforcement are another counter.
    expect(second.storageUsedBytes).toBe(empty.storageUsedBytes);
    expect(second.storageUpdatedAt).toEqual(empty.storageUpdatedAt);

    // Collection releases revision 0: b goes with its directory, while a
    // stays because revision 1 still names it. Marked collected but not yet
    // deleted (a pass whose deletes failed), b is still counted.
    const store = createPostgresCheckpointStore(db);
    const collected = { keep: [1], throughRevision: 1 };
    expect(await store.markCollected(sessionId, collected)).toBe(1);
    expect((await usage()).outputsUsedBytes).toBe(180);

    await store.markPurged(sessionId, collected);
    const [purged] = await db
      .select({ at: checkpoints.objectsPurgedAt })
      .from(checkpoints)
      .where(
        and(eq(checkpoints.sessionId, sessionId), eq(checkpoints.revision, 0)),
      );
    expect(purged?.at).not.toBeNull();
    const released = await usage();
    expect(released.outputsUsedBytes).toBe(130);
    expect(released.outputsUpdatedAt).toEqual(purged?.at ?? null);
  });

  test("records a checkpoint naming as many objects as a manifest may", async () => {
    const before = await usage();
    const { commit, key } = await claimedSession();
    await commit(
      0,
      Array.from({ length: 20_000 }, (_, index) => ({
        key: key(0, `${index}`),
        bytes: 1,
      })),
    );
    expect((await usage()).outputsUsedBytes).toBe(
      before.outputsUsedBytes + 20_000,
    );
  });

  test("reports itself partial while a kept checkpoint predates output recording", async () => {
    const before = await usage();
    expect(before.outputsComplete).toBe(true);

    const { sessionId, commit } = await claimedSession();
    await commit(0);
    const partial = await usage();
    expect(partial.outputsComplete).toBe(false);
    expect(partial.outputsUsedBytes).toBe(before.outputsUsedBytes);

    // Collected but not yet deleted, its outputs may still be stored; once a
    // pass deletes them, nothing unrecorded is kept.
    await commit(1, []);
    const store = createPostgresCheckpointStore(db);
    const collected = { keep: [1], throughRevision: 1 };
    await store.markCollected(sessionId, collected);
    expect((await usage()).outputsComplete).toBe(false);
    await store.markPurged(sessionId, collected);
    expect((await usage()).outputsComplete).toBe(true);
  });
});
