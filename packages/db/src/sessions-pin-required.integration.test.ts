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
import { flipPinCutover } from "./session-pin-cutover.ts";

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

integration("the session pin trigger on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "sessions_pin_required_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

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

  const turnOn = async () => {
    const result = await flipPinCutover(db as unknown as Database);
    if (!result.flipped) throw new Error("the gate is not open");
  };
  // drizzle wraps the database error; the trigger's message is on its cause.
  const refused = async (write: () => Promise<unknown>) => {
    const error = await write().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? (error as Error).message).toMatch(
      /session_pin_required/,
    );
  };

  test(
    "with the flag off, a session of no release is created and changed as before",
    async () => {
      const id = await start(null);
      await db.update(sessions).set({ title: "t" }).where(eq(sessions.id, id));
      await db
        .update(sessions)
        .set({ status: "stopped" })
        .where(eq(sessions.id, id));
      await db
        .update(sessions)
        .set({ status: "queued" })
        .where(eq(sessions.id, id));
      expect(
        (await db.select().from(sessions).where(eq(sessions.id, id)))[0]
          ?.status,
      ).toBe("queued");
    },
    TIMEOUT_MS,
  );

  test(
    "with the flag on, a session of no release is not created, and a stopped one is not brought back",
    async () => {
      const ended = await start(null);
      await db
        .update(sessions)
        .set({ status: "stopped" })
        .where(eq(sessions.id, ended));
      await turnOn();

      await refused(() => start(null));
      await refused(async () => {
        await db
          .update(sessions)
          .set({ status: "queued" })
          .where(eq(sessions.id, ended));
      });
      // Ending one, or changing an ended one in other ways, is not refused.
      await db
        .update(sessions)
        .set({ title: "kept" })
        .where(eq(sessions.id, ended));
    },
    TIMEOUT_MS,
  );

  test(
    "with the flag on, a session with a pin starts, runs and moves model with its pin, and loses neither the pin nor its model's match",
    async () => {
      const rel = await release();
      await turnOn();
      const id = await start(rel);

      // The ordinary writes of a live session are untouched.
      for (const status of ["running", "idle", "queued"] as const) {
        await db.update(sessions).set({ status }).where(eq(sessions.id, id));
      }
      // A model changed without the pin is refused; the pin goes with it.
      await refused(async () => {
        await db
          .update(sessions)
          .set({ model: "sonnet-5-1" })
          .where(eq(sessions.id, id));
      });
      await refused(async () => {
        await db
          .update(sessions)
          .set({
            specSource: null,
            runtimeSpec: null,
            specSourceDigest: null,
            specDigest: null,
          })
          .where(eq(sessions.id, id));
      });
    },
    TIMEOUT_MS,
  );

  test(
    "a row that holds the pin never fires the trigger function",
    async () => {
      const rel = await release();
      await turnOn();
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL track_functions = 'all'");
        const writer = drizzle(client, { schema });
        const id = await (async () => {
          const accepted = await createPostgresSessionUnitOfWork(
            writer as unknown as NodePgDatabase<typeof schema>,
          ).acceptInputAtomic({
            limits: {
              queuedInputLimitPerSession: 1_000,
              storageLimitBytes: 1e15,
            },
            principal: { ownerId: crypto.randomUUID() },
            idempotencyKey: crypto.randomUUID(),
            payloadHash: crypto.randomUUID(),
            profileId: "p",
            repository: "none",
            model: "sonnet-5-0",
            agentReleaseId: rel,
            message: "go",
          });
          if (accepted.outcome !== "accepted") throw new Error("not accepted");
          return accepted.response.session_id;
        })();
        await writer
          .update(sessions)
          .set({ status: "running" })
          .where(eq(sessions.id, id));
        const calls = await client.query(
          `SELECT coalesce(pg_stat_get_xact_function_calls('sessions_pin_required'::regproc), 0) AS calls`,
        );
        expect(Number(calls.rows[0].calls)).toBe(0);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a repeatable read writer of such a row is refused whatever the flag says",
    async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await expect(
          client.query(
            `INSERT INTO sessions (id, owner_id, profile_id, model, status, repository_mode)
             VALUES ($1, $2, 'p', 'sonnet-5-0', 'queued', 'none')`,
            [crypto.randomUUID(), crypto.randomUUID()],
          ),
        ).rejects.toThrow("read committed");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a writer of a violating row holds the flip off until it commits, and the flip then reads it",
    async () => {
      const client = await pool.connect();
      let flip: Promise<unknown> | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        // Flag off: this row is allowed, and the trigger takes the shared lock.
        await client.query(
          `INSERT INTO sessions (id, owner_id, profile_id, model, status, repository_mode)
           VALUES ($1, $2, 'p', 'sonnet-5-0', 'queued', 'none')`,
          [crypto.randomUUID(), crypto.randomUUID()],
        );
        let settled = false;
        flip = flipPinCutover(db as unknown as Database).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const result = (await flip) as { flipped: boolean; reason?: string };
      expect(result).toMatchObject({ flipped: false, reason: "gate_closed" });
    },
    TIMEOUT_MS,
  );
});
