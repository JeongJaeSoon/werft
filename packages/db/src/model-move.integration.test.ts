import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CatalogConnection,
  createWorkerGateway,
  type ModelMove,
  modelMoves,
  verifyReleaseSpec,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  events,
  sessions,
  unassignedSessions,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import {
  makeFixtureRelease,
  sessionPinColumns,
  TEST_CONNECTION_ID,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import {
  createPostgresWorkerUnitOfWork,
  moveSessionsToSuccessors,
} from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const TIMEOUT_MS = 30_000;

type Offer = Pick<CatalogConnection, "models" | "model_families">;
const offerOf = (
  models: string[],
  families: NonNullable<CatalogConnection["model_families"]>,
): Offer => ({ models, model_families: families });

/** The moves a claim on `offer` makes, on the test connection. */
const movesFrom = (offer: Offer, from: string): ModelMove[] =>
  modelMoves(offer)
    .filter((move) => move.from === from)
    .map((move) => ({ connectionId: TEST_CONNECTION_ID, ...move }));

const SERIES = {
  "sonnet-5-0": { family: "sonnet", rank: 0 },
  "sonnet-5-1": { family: "sonnet", rank: 1 },
  "haiku-5-0": { family: "haiku", rank: 0 },
};

const snakeSpec = (row: typeof sessions.$inferSelect) => ({
  spec_source: row.specSource,
  runtime_spec: row.runtimeSpec,
  spec_source_digest: row.specSourceDigest,
  spec_digest: row.specDigest,
});

integration("a model moved at the next turn's claim", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "model_move_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const gatewayFor = (offer: Offer) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testSessionCatalog({
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: {
            kind: "api_key",
            value: "catalog-provider-key",
            ref: { value_env: "PROVIDER_KEY" },
          },
        },
        models: offer.models,
        ...(offer.model_families === undefined
          ? {}
          : { model_families: offer.model_families }),
        repositories: {
          app: {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 30_000,
        now: () => new Date("2026-09-24T00:00:00.000Z"),
        sleep: async () => {},
      },
    });

  /** A queued session of a new agent's release on `model`. */
  async function waiting(partition: string, model: string) {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: crypto.randomUUID() },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await makeFixtureRelease(db, { model }),
      model,
      repository: {
        id: "app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const id = accepted.response.session_id;
    await db.update(sessions).set({ partition }).where(eq(sessions.id, id));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, id));
    return id;
  }

  const claimOf = (
    gateway: ReturnType<typeof gatewayFor>,
    launch: Awaited<ReturnType<typeof launchSession>>,
  ) =>
    gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: launch.executionId,
        execution_generation: launch.generation,
        credential: { kind: "launch_nonce", nonce: launch.nonce },
      },
    );

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  };

  const migrations = async (id: string) =>
    (
      await db
        .select()
        .from(events)
        .where(eq(events.sessionId, id))
        .orderBy(asc(events.id))
    ).filter(
      (event) =>
        (event.payload as { subtype?: string } | null)?.subtype ===
        "model_migrated",
    );

  test(
    "a waiting session whose model left moves to the next one of its series and says so",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `move-${crypto.randomUUID()}`;
      const id = await waiting(partition, "sonnet-5-0");
      const launch = await launchSession(db, { sessionId: id });

      const claimed = await claimOf(gatewayFor(offer), launch);

      expect(claimed.runtime_config.model).toBe("sonnet-5-1");
      expect((await rowOf(id)).model).toBe("sonnet-5-1");
      const [event, ...more] = await migrations(id);
      expect(more).toEqual([]);
      expect(event?.type).toBe("system");
      expect(event?.payload).toMatchObject({
        type: "system",
        subtype: "model_migrated",
        from: "sonnet-5-0",
        to: "sonnet-5-1",
      });
    },
    TIMEOUT_MS,
  );

  /** Sets the move switch of the agent the session's release belongs to. */
  async function ofAgent(sessionId: string, autoModelMigration: boolean) {
    const row = await rowOf(sessionId);
    const [release] = await db
      .select({ agentId: agentReleases.agentId })
      .from(agentReleases)
      .where(eq(agentReleases.id, row.agentReleaseId ?? ""));
    if (!release) throw new Error("session has no release");
    await db
      .update(agents)
      .set({ autoModelMigration })
      .where(eq(agents.id, release.agentId));
    return release.agentId;
  }

  test(
    "a session of an agent that switched the move off stays blocked where it is, and one of an agent that left it on moves",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `optout-${crypto.randomUUID()}`;
      const off = await waiting(partition, "sonnet-5-0");
      await ofAgent(off, false);
      const on = await waiting(partition, "sonnet-5-0");
      await ofAgent(on, true);

      const offLaunch = await launchSession(db, { sessionId: off });
      await expect(claimOf(gatewayFor(offer), offLaunch)).rejects.toBeDefined();
      expect((await rowOf(off)).model).toBe("sonnet-5-0");
      expect(await migrations(off)).toEqual([]);

      const onLaunch = await launchSession(db, { sessionId: on });
      await claimOf(gatewayFor(offer), onLaunch);
      expect((await rowOf(on)).model).toBe("sonnet-5-1");
      expect(await migrations(on)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a family with nothing newer listed stays blocked and nothing moves",
    async () => {
      const after = offerOf(["haiku-5-0"], SERIES);
      const partition = `block-${crypto.randomUUID()}`;
      const id = await waiting(partition, "sonnet-5-0");
      const launch = await launchSession(db, { sessionId: id });

      await expect(claimOf(gatewayFor(after), launch)).rejects.toBeDefined();

      expect((await rowOf(id)).model).toBe("sonnet-5-0");
      expect(await migrations(id)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a session already on a pod keeps its model until its turn is over",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pod-${crypto.randomUUID()}`;
      const running = await waiting(partition, "sonnet-5-1");
      const runningLaunch = await launchSession(db, { sessionId: running });
      await claimOf(gatewayFor(offer), runningLaunch);
      await db
        .update(sessions)
        .set(sessionPinColumns("sonnet-5-0"))
        .where(eq(sessions.id, running));

      const other = await waiting(partition, "sonnet-5-0");
      const otherLaunch = await launchSession(db, { sessionId: other });
      await claimOf(gatewayFor(offer), otherLaunch);

      expect((await rowOf(other)).model).toBe("sonnet-5-1");
      expect((await rowOf(running)).model).toBe("sonnet-5-0");
      expect(await migrations(running)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a moved session's spec pin follows its model in the same statement, and the release's stays",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pin-${crypto.randomUUID()}`;
      const pinned = await waiting(partition, "sonnet-5-0");
      const releaseId = (await rowOf(pinned)).agentReleaseId ?? "";
      const [before] = await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, releaseId));

      await db.transaction((tx) =>
        moveSessionsToSuccessors(
          tx,
          { partition, sessionId: null },
          { modelMoves: movesFrom(offer, "sonnet-5-0"), now: new Date() },
        ),
      );

      const after = await rowOf(pinned);
      expect(after.model).toBe("sonnet-5-1");
      expect(after.runtimeSpec?.model).toBe("sonnet-5-1");
      expect(after.specSource?.model).toBe("sonnet-5-1");
      expect(
        (after.specSource?.connection as { id?: string } | undefined)?.id,
      ).toBe(TEST_CONNECTION_ID);
      expect(verifyReleaseSpec(snakeSpec(after)).ok).toBe(true);
      const [release] = await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, releaseId));
      expect(release?.specDigest).toBe(before?.specDigest);
      expect(release?.specSource?.model).toBe("sonnet-5-0");
    },
    TIMEOUT_MS,
  );

  test(
    "a new session of a release starts with its spec under the session's own model",
    async () => {
      const releaseId = await makeFixtureRelease(db, { model: "sonnet-5-0" });
      const accepted = await createPostgresSessionUnitOfWork(
        db,
      ).acceptInputAtomic({
        limits: {
          queuedInputLimitPerSession: 1_000,
          storageLimitBytes: 1e15,
        },
        principal: { ownerId: crypto.randomUUID() },
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        repository: "none",
        model: "sonnet-5-1",
        agentReleaseId: releaseId,
        message: "go",
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      const pinned = await rowOf(accepted.response.session_id);
      expect(pinned.model).toBe("sonnet-5-1");
      expect(pinned.specSource?.model).toBe("sonnet-5-1");
      expect(verifyReleaseSpec(snakeSpec(pinned)).ok).toBe(true);
      const [release] = await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, releaseId));
      expect(release?.specSource?.model).toBe("sonnet-5-0");
    },
    TIMEOUT_MS,
  );

  test(
    "a partition-wide pass moves the waiting session and skips the one on a pod, even when both are signalled",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pass-${crypto.randomUUID()}`;
      const onPod = await waiting(partition, "sonnet-5-0");
      const idle = await waiting(partition, "sonnet-5-0");
      await db
        .update(sessions)
        .set({ podId: crypto.randomUUID() })
        .where(eq(sessions.id, onPod));
      const moves = movesFrom(offer, "sonnet-5-0");

      const moved = await db.transaction((tx) =>
        moveSessionsToSuccessors(
          tx,
          { partition, sessionId: null },
          { modelMoves: moves, now: new Date() },
        ),
      );

      expect(moved).toBe(1);
      expect((await rowOf(idle)).model).toBe("sonnet-5-1");
      expect((await rowOf(onPod)).model).toBe("sonnet-5-0");
      expect(await migrations(onPod)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a session another transaction holds at claim is waited for, not given up on",
    async () => {
      const offer = offerOf(["sonnet-5-1", "haiku-5-0"], SERIES);
      const id = await waiting(`lock-${crypto.randomUUID()}`, "sonnet-5-0");
      const launch = await launchSession(db, { sessionId: id });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
          id,
        ]);
        const claiming = claimOf(gatewayFor(offer), launch);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await holder.query("COMMIT");

        const claimed = await claiming;

        expect(claimed.runtime_config.model).toBe("sonnet-5-1");
        expect((await rowOf(id)).model).toBe("sonnet-5-1");
      } finally {
        holder.release();
      }
    },
    TIMEOUT_MS,
  );
});
