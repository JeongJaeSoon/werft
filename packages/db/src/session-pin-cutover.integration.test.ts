import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { SpecSource } from "@werft-ai/contracts";
import { releaseSpecRecord } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { agentReleases, sessionPinCutover, sessions } from "./schema.ts";
import {
  flipPinCutover,
  listStrandedSessions,
  pinWriterGuard,
} from "./session-pin-cutover.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const TIMEOUT_MS = 30_000;

const sourceOf = (releaseId: string): SpecSource => ({
  derivation_version: 1,
  origin: "agent",
  release_id: releaseId,
  release_id_version: 5,
  profile_id: "p",
  profile_digest: "digest",
  runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
  connection: {
    id: "conn-1",
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    billing: "per_token",
  },
  model: "sonnet-5-0",
  permission_mode: "default",
  tools: ["Read"],
  repository_mode: "none",
});

integration("session pin cutover on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_pin_cutover_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  // The gate counts every live session, and the flag is one row for the
  // database, so each test starts with none and the flag off.
  beforeEach(async () => {
    await db.update(sessions).set({ status: "stopped" });
    await db
      .update(sessionPinCutover)
      .set({ authoritative: false, flippedAt: null });
  });

  async function release() {
    const id = `rel-${crypto.randomUUID()}`;
    const record = releaseSpecRecord(sourceOf(id));
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await drizzle(client, { schema })
        .insert(agentReleases)
        .values({
          id,
          agentId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          cardSha256: "0".repeat(64),
          runtimeProfileId: "p",
          profileDigest: "digest",
          runtimeConfigSnapshot: {},
          effectiveTools: { tools: [], mcp: [] },
          specSource: record.spec_source,
          specSourceDigest: record.spec_source_digest,
          runtimeSpec: record.runtime_spec,
          specDigest: record.spec_digest,
        });
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
    return id;
  }

  async function start(releaseId: string | null) {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: crypto.randomUUID() },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "p",
      repository: "none",
      model: "sonnet-5-0",
      ...(releaseId === null ? {} : { agentReleaseId: releaseId }),
      message: "go",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    return accepted.response.session_id;
  }

  const flag = async () => {
    const [row] = await db.select().from(sessionPinCutover);
    return row;
  };

  test(
    "a live session of no release keeps the flag off and is listed with what a stop keeps",
    async () => {
      const stranded = await start(null);

      const result = await flipPinCutover(db as unknown as Database);

      expect(result.flipped).toBe(false);
      if (result.flipped || result.reason !== "gate_closed") {
        throw new Error("expected a closed gate");
      }
      expect(result.gate.releaseLess).toBe(1);
      expect((await flag())?.authoritative).toBe(false);
      const listed = await listStrandedSessions(db as unknown as Database);
      expect(listed.map((s) => s.id)).toEqual([stranded]);
      expect(listed[0]?.queuedInputs).toBe(1);
      expect(listed[0]?.lastCheckpoint).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "flips once the stranded session has ended, and never flips back or twice",
    async () => {
      const stranded = await start(null);
      await db
        .update(sessions)
        .set({ status: "stopped" })
        .where(eq(sessions.id, stranded));
      const rel = await release();
      await start(rel);

      const first = await flipPinCutover(db as unknown as Database);
      const second = await flipPinCutover(db as unknown as Database);

      expect(first.flipped).toBe(true);
      expect(second).toEqual({
        flipped: false,
        reason: "already_authoritative",
      });
      const row = await flag();
      expect(row?.authoritative).toBe(true);
      expect(row?.flippedAt).not.toBeNull();
      expect(await listStrandedSessions(db as unknown as Database)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "the row cannot say authoritative without a time, nor be a second row",
    async () => {
      await expect(
        (async () => {
          await db.update(sessionPinCutover).set({ authoritative: true });
        })(),
      ).rejects.toThrow();
      await expect(
        (async () => {
          await db.insert(sessionPinCutover).values({ id: 2 });
        })(),
      ).rejects.toThrow();
    },
    TIMEOUT_MS,
  );

  test(
    "a writer holding the lock makes the flip wait, and the flip then sees what the writer committed",
    async () => {
      const client = await pool.connect();
      const writer = drizzle(client, { schema });
      await client.query("BEGIN");
      let flip: Promise<unknown> | undefined;
      try {
        const guard = await pinWriterGuard(writer as unknown as Database);
        expect(guard.authoritative).toBe(false);
        let settled = false;
        flip = flipPinCutover(db as unknown as Database).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        // The writer creates a session of no release before it commits.
        await client.query(
          `INSERT INTO sessions (id, owner_id, profile_id, model, status, repository_mode)
           SELECT $1, $2, 'p', 'sonnet-5-0', 'queued', 'none'`,
          [crypto.randomUUID(), crypto.randomUUID()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const result = (await flip) as { flipped: boolean; reason?: string };
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe("gate_closed");
      expect((await flag())?.authoritative).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a writer reads the flag after the lock, and refuses a transaction whose snapshot could be older",
    async () => {
      const rel = await release();
      await start(rel);
      await flipPinCutover(db as unknown as Database);

      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const guard = await pinWriterGuard(
          drizzle(client, { schema }) as unknown as Database,
        );
        expect(guard.authoritative).toBe(true);
        await client.query("ROLLBACK");

        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await expect(
          pinWriterGuard(drizzle(client, { schema }) as unknown as Database),
        ).rejects.toThrow("read committed");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
    TIMEOUT_MS,
  );
});
