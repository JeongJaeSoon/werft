import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { checkpoints, sessions } from "../schema.ts";
import { waitsOn } from "../testing/lock-wait.ts";
import { createPostgresCheckpointStore } from "./checkpoint-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * recordBundleVerdict beside a write that withdraws verdicts. The trigger
 * that removes them cannot see a verdict not yet committed, so the record
 * locks the checkpoint rows first; PGlite has one connection, so the wait
 * needs PostgreSQL.
 */
integration(
  "remembering a bundle verdict beside a collection, on PostgreSQL",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "bundle_verdict_it" });
      pool = new Pool({ connectionString: database.url, max: 4 });
      db = drizzle(pool, { schema });
    }, 60_000);

    afterAll(async () => {
      await pool.end();
      await database.drop();
    }, 60_000);

    async function sessionWithCheckpoints(revisions: number): Promise<string> {
      const id = crypto.randomUUID();
      await db.insert(sessions).values({
        id,
        ownerId: "owner-verdicts",
        repoUrl: "https://example.invalid/app.git",
        branch: `session/${id}`,
        status: "stopped",
        admissionState: "stopped",
        checkpointRevision: revisions - 1,
      });
      for (let revision = 0; revision < revisions; revision += 1) {
        await db.insert(checkpoints).values({
          sessionId: id,
          revision,
          manifestRef: `${id}/checkpoints/${revision}/manifest.json`,
          manifestSha256: `manifest-${revision}`,
        });
      }
      return id;
    }

    /** Collects `revision` in a transaction left open until `then` returns. */
    async function whileCollecting(
      sessionId: string,
      revision: number,
      then: (collector: number) => Promise<void>,
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await client.query(
          "UPDATE checkpoints SET collected_at = now() WHERE session_id = $1 AND revision = $2",
          [sessionId, revision],
        );
        await then(rows[0]?.pid as number);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    test("a record made while its checkpoint is being collected waits for the collection, then keeps nothing", async () => {
      const sessionId = await sessionWithCheckpoints(2);
      const store = createPostgresCheckpointStore(db);
      let settled = false;
      let recording: Promise<void> | undefined;
      await whileCollecting(sessionId, 1, async (collector) => {
        recording = store
          .recordBundleVerdict?.({
            key: "key-1",
            manifestSha256: "manifest-1",
            prerequisiteRevisions: [0],
            revision: 1,
            sessionId,
          })
          .finally(() => {
            settled = true;
          });
        expect(await waitsOn(db, collector, () => settled)).toBe(true);
      });
      await recording;
      expect(await store.listBundleVerdicts?.(sessionId, [0, 1])).toEqual([]);
    });

    test("a record waits for a collection of a checkpoint it builds on as well", async () => {
      const sessionId = await sessionWithCheckpoints(2);
      const store = createPostgresCheckpointStore(db);
      let settled = false;
      let recording: Promise<void> | undefined;
      await whileCollecting(sessionId, 0, async (collector) => {
        recording = store
          .recordBundleVerdict?.({
            key: "key-1",
            manifestSha256: "manifest-1",
            prerequisiteRevisions: [0],
            revision: 1,
            sessionId,
          })
          .finally(() => {
            settled = true;
          });
        expect(await waitsOn(db, collector, () => settled)).toBe(true);
      });
      await recording;
      // Verified after that collection, so it stands: the bundles it read
      // are the ones revision 1 still keeps.
      expect(await store.listBundleVerdicts?.(sessionId, [0, 1])).toEqual([
        { key: "key-1", revision: 1 },
      ]);
    });
  },
);
