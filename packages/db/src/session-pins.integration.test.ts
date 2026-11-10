import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { SpecSource } from "@werft-ai/contracts";
import { releaseSpecRecord, verifyReleaseSpec } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { agentReleases, sessionPinCutover, sessions } from "./schema.ts";
import { flipPinCutover } from "./session-pin-cutover.ts";
import { reconcileSessionPins, sessionPinGate } from "./session-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const TIMEOUT_MS = 30_000;

const sourceOf = (releaseId: string, model: string): SpecSource => ({
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
  model,
  permission_mode: "default",
  tools: ["Read"],
  repository_mode: "none",
});

integration("session pin reconciliation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_pins_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  // The gate counts every live session and the reconciliation reads every
  // session of a release, so each test starts with none of either: the old
  // rows end and let go of their release.
  beforeEach(async () => {
    await db.update(sessions).set({ status: "stopped", agentReleaseId: null });
  });

  async function release(withSpec: boolean) {
    const id = `rel-${crypto.randomUUID()}`;
    const record = releaseSpecRecord(sourceOf(id, "sonnet-5-0"));
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
          ...(withSpec
            ? {
                specSource: record.spec_source,
                specSourceDigest: record.spec_source_digest,
                runtimeSpec: record.runtime_spec,
                specDigest: record.spec_digest,
              }
            : {}),
        });
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
    return id;
  }

  async function start(releaseId: string | null, model = "sonnet-5-0") {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: crypto.randomUUID() },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "p",
      repository: "none",
      model,
      ...(releaseId === null ? {} : { agentReleaseId: releaseId }),
      message: "go",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    return accepted.response.session_id;
  }

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  };
  const snake = (row: typeof sessions.$inferSelect) => ({
    spec_source: row.specSource,
    runtime_spec: row.runtimeSpec,
    spec_source_digest: row.specSourceDigest,
    spec_digest: row.specDigest,
  });
  const unpin = (id: string) =>
    db
      .update(sessions)
      .set({
        specSource: null,
        runtimeSpec: null,
        specSourceDigest: null,
        specDigest: null,
      })
      .where(eq(sessions.id, id));

  test(
    "writes a missing pin, moves a pin that an old replica left on the old model, and rewrites a pin that no longer verifies",
    async () => {
      const rel = await release(true);
      const missing = await start(rel);
      await unpin(missing);
      const stale = await start(rel);
      // An old replica's model move writes the model and nothing else.
      await db
        .update(sessions)
        .set({ model: "sonnet-5-1" })
        .where(eq(sessions.id, stale));
      const broken = await start(rel);
      await db
        .update(sessions)
        .set({ specDigest: "f".repeat(64) })
        .where(eq(sessions.id, broken));
      const fine = await start(rel);
      const fineBefore = await rowOf(fine);

      const report = await reconcileSessionPins(db);

      expect(report).toEqual({
        repaired: 3,
        raced: 0,
        unresolved: 0,
        modelUnknown: 0,
      });
      for (const id of [missing, stale, broken]) {
        const row = await rowOf(id);
        expect(verifyReleaseSpec(rel, snake(row)).ok).toBe(true);
        expect(row.runtimeSpec?.model).toBe(row.model as string);
      }
      expect((await rowOf(stale)).runtimeSpec?.model).toBe("sonnet-5-1");
      expect(await rowOf(fine)).toEqual(fineBefore);
      expect(await reconcileSessionPins(db)).toEqual({
        repaired: 0,
        raced: 0,
        unresolved: 0,
        modelUnknown: 0,
      });
    },
    TIMEOUT_MS,
  );

  test(
    "does not guess a session without a model, or one whose release has no spec yet",
    async () => {
      const bare = await release(false);
      const noSpec = await start(bare);
      const withSpec = await release(true);
      const noModel = await start(withSpec);
      await unpin(noModel);
      await db
        .update(sessions)
        .set({ model: null })
        .where(eq(sessions.id, noModel));

      const report = await reconcileSessionPins(db);

      expect(report).toEqual({
        repaired: 0,
        raced: 0,
        unresolved: 1,
        modelUnknown: 1,
      });
      expect((await rowOf(noSpec)).specSource).toBeNull();
      expect((await rowOf(noModel)).specSource).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "two runs at once repair a session once and leave a pin that verifies",
    async () => {
      const rel = await release(true);
      const id = await start(rel);
      await db
        .update(sessions)
        .set({ model: "sonnet-5-1" })
        .where(eq(sessions.id, id));

      const reports = await Promise.all([
        reconcileSessionPins(db),
        reconcileSessionPins(db),
      ]);

      expect(reports.reduce((n, r) => n + r.repaired, 0)).toBe(1);
      const row = await rowOf(id);
      expect(row.runtimeSpec?.model).toBe("sonnet-5-1");
      expect(verifyReleaseSpec(rel, snake(row)).ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "a model move that commits between the read and the write is not overwritten by the pin read before it",
    async () => {
      const rel = await release(true);
      const id = await start(rel);
      await db
        .update(sessions)
        .set({ model: "sonnet-5-1" })
        .where(eq(sessions.id, id));
      const mover = await pool.connect();
      try {
        // A model move holds the row; the reconciliation reads the stale pin
        // without blocking and its write waits on that lock.
        await mover.query("BEGIN");
        await mover.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [
          id,
        ]);
        const running = reconcileSessionPins(db);
        for (let i = 0; i < 50; i += 1) {
          const { rows } = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          if (rows.length > 0) break;
          await Bun.sleep(100);
        }
        await mover.query("UPDATE sessions SET model = $2 WHERE id = $1", [
          id,
          "sonnet-5-2",
        ]);
        await mover.query("COMMIT");

        const report = await running;

        expect(report.raced).toBe(1);
        expect(report.repaired).toBe(0);
        const row = await rowOf(id);
        expect(row.model).toBe("sonnet-5-2");
        // The pin read for sonnet-5-1 was not written over the new model.
        expect(row.runtimeSpec?.model).not.toBe("sonnet-5-1");
        // The next run pins the session where it stands now.
        await reconcileSessionPins(db);
        expect((await rowOf(id)).runtimeSpec?.model).toBe("sonnet-5-2");
      } finally {
        mover.release();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a session that changes kind while the gate counts is still counted: the five counts read one snapshot",
    async () => {
      const rel = await release(true);
      const id = await start(rel);
      // Neither a model nor a pin: the `modelUnknown` kind.
      await unpin(id);
      await db.update(sessions).set({ model: null }).where(eq(sessions.id, id));

      // After the first count finishes, a model backfill fills the model on
      // another connection. Counted one query at a time, the row would then
      // fall out of `missing` (read before) and `modelUnknown` (read after).
      let interfered = false;
      const wrap = (client: PoolClient): PoolClient =>
        new Proxy(client, {
          get(target, prop) {
            if (prop === "query") {
              return async (...args: unknown[]) => {
                const first = args[0] as string | { text: string };
                const text = typeof first === "string" ? first : first.text;
                const result = await (
                  target.query as (...a: unknown[]) => Promise<unknown>
                )(...args);
                if (!interfered && /count\(\*\)/.test(text)) {
                  interfered = true;
                  await pool.query(
                    "UPDATE sessions SET model = 'sonnet-5-0' WHERE id = $1",
                    [id],
                  );
                }
                return result;
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      const watched = new Proxy(pool, {
        get(target, prop) {
          if (prop === "connect") {
            return async () => wrap(await target.connect());
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const gate = await sessionPinGate(drizzle(watched, { schema }));

      expect(interfered).toBe(true);
      expect(gate.modelUnknown).toBe(1);
      expect(gate.missing).toBe(0);
      expect(gate.open).toBe(false);
      // The row did change underneath: the next gate sees it as missing.
      const next = await sessionPinGate(db);
      expect(next.missing).toBe(1);
      expect(next.modelUnknown).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "once the pin is authoritative, a new input revives a failed session only if it has a pin on its own model, and a refusal records nothing",
    async () => {
      const ownerId = crypto.randomUUID();
      const inputs = createPostgresSessionUnitOfWork(db);
      const limits = {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
      };
      const first = async (releaseId: string | null) => {
        const accepted = await inputs.acceptInputAtomic({
          limits,
          principal: { ownerId },
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          profileId: "p",
          repository: "none",
          model: "sonnet-5-0",
          ...(releaseId === null ? {} : { agentReleaseId: releaseId }),
          message: "go",
        });
        if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
        const id = accepted.response.session_id;
        await db
          .update(sessions)
          .set({ status: "failed" })
          .where(eq(sessions.id, id));
        return id;
      };
      const append = (sessionId: string) =>
        inputs.appendInputAtomic({
          limits,
          principal: { ownerId },
          sessionId,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          message: "again",
        });
      const pinned = await first(await release(true));
      const bare = await first(null);

      await db
        .update(sessionPinCutover)
        .set({ authoritative: true, flippedAt: new Date() });
      try {
        const before = await rowOf(bare);
        expect(await append(bare)).toEqual({ outcome: "pin_required" });
        expect(await rowOf(bare)).toEqual(before);
        const revived = await append(pinned);
        expect(revived.outcome).toBe("accepted");
        expect((await rowOf(pinned)).status).toBe("queued");
      } finally {
        await db
          .update(sessionPinCutover)
          .set({ authoritative: false, flippedAt: null });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an ended session is pinned too, because a resume, a recovery decision or a new input brings it back and the flip refuses a live session without a pin",
    async () => {
      const rel = await release(true);
      const stopped = await start(rel);
      await unpin(stopped);
      await db
        .update(sessions)
        .set({ status: "stopped" })
        .where(eq(sessions.id, stopped));
      const failed = await start(rel);
      await unpin(failed);
      await db
        .update(sessions)
        .set({ status: "failed" })
        .where(eq(sessions.id, failed));

      const report = await reconcileSessionPins(db);

      expect(report.repaired).toBe(2);
      for (const id of [stopped, failed]) {
        expect(verifyReleaseSpec(rel, snake(await rowOf(id))).ok).toBe(true);
      }
      // A pin that already holds is not read again for an ended session.
      expect(await reconcileSessionPins(db)).toEqual({
        repaired: 0,
        raced: 0,
        unresolved: 0,
        modelUnknown: 0,
      });
      // The gate still reads live sessions only, so a stopped one never
      // holds the flip back.
      expect((await sessionPinGate(db)).open).toBe(true);
      // Brought back after the flip, the pinned session is let through.
      expect((await flipPinCutover(db)).flipped).toBe(true);
      try {
        await db
          .update(sessions)
          .set({ status: "queued" })
          .where(eq(sessions.id, stopped));
        expect((await rowOf(stopped)).status).toBe("queued");
      } finally {
        // The flip is for good in production; the other tests here need the
        // old rules back.
        await db
          .update(sessionPinCutover)
          .set({ authoritative: false, flippedAt: null });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the gate counts each kind of session it cannot pass and opens only at zero",
    async () => {
      const rel = await release(true);
      const missing = await start(rel);
      await unpin(missing);
      const mismatched = await start(rel);
      await db
        .update(sessions)
        .set({ model: "sonnet-5-1" })
        .where(eq(sessions.id, mismatched));
      const broken = await start(rel);
      await db
        .update(sessions)
        .set({ specDigest: "f".repeat(64) })
        .where(eq(sessions.id, broken));
      const noModel = await start(rel);
      await unpin(noModel);
      await db
        .update(sessions)
        .set({ model: null })
        .where(eq(sessions.id, noModel));
      const modelOnlyNull = await start(rel);
      await db
        .update(sessions)
        .set({ model: null })
        .where(eq(sessions.id, modelOnlyNull));
      await start(null);

      const before = await sessionPinGate(db);

      // `mismatched` counts the broken pin's session too only if its model
      // differs; the null-model session with a pin differs by IS DISTINCT FROM.
      expect(before).toEqual({
        missing: 1,
        mismatched: 2,
        unverifiable: 1,
        modelUnknown: 1,
        releaseLess: 1,
        open: false,
      });

      await db.update(sessions).set({ status: "stopped" });
      const ended = await sessionPinGate(db);
      expect(ended.open).toBe(true);
    },
    TIMEOUT_MS,
  );
});
