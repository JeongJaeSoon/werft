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

    /** Revision 1's pass, whose bundles build on revision 0's. */
    const pass = (sessionId: string) => ({
      manifestSha256: "manifest-1",
      prerequisiteRevisions: [0],
      revision: 1,
      sessionId,
    });

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

    // The verification began before the collection; its record arrives
    // while the collection is still open.
    test.each([
      ["its own checkpoint", 1],
      ["a checkpoint it builds on", 0],
    ] as const)(
      "a record made while %s is being collected waits for the collection, then keeps nothing",
      async (_which, collected) => {
        const sessionId = await sessionWithCheckpoints(2);
        const store = createPostgresCheckpointStore(db);
        const basis = (await store.bundleVerdictBasis?.(pass(sessionId))) ?? "";
        let settled = false;
        let recording: Promise<void> | undefined;
        await whileCollecting(sessionId, collected, async (collector) => {
          recording = store
            .recordBundleVerdict?.({ ...pass(sessionId), basis, key: "key-1" })
            .finally(() => {
              settled = true;
            });
          expect(await waitsOn(db, collector, () => settled)).toBe(true);
        });
        await recording;
        expect(await store.listBundleVerdicts?.(sessionId, [0, 1])).toEqual([]);
      },
    );

    test("verified again after a prerequisite's collection, the pass is kept", async () => {
      const sessionId = await sessionWithCheckpoints(2);
      const store = createPostgresCheckpointStore(db);
      await whileCollecting(sessionId, 0, async () => {});
      await store.recordBundleVerdict?.({
        ...pass(sessionId),
        basis: (await store.bundleVerdictBasis?.(pass(sessionId))) ?? "",
        key: "key-1",
      });
      expect(await store.listBundleVerdicts?.(sessionId, [0, 1])).toEqual([
        { key: "key-1", revision: 1 },
      ]);
    });
  },
);
