import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  createWorkerGateway,
  modelMovePins,
  profileFingerprint,
  withSeededInstallation,
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
import { events, sessions, unassignedSessions } from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import {
  createPostgresWorkerUnitOfWork,
  moveSessionsToSuccessors,
} from "./worker-unit-of-work.ts";

// A session that waits for its turn on a model the profile dropped moves to
// the next model of the same series when a worker claims it; one with no such
// successor stays blocked as it was; one already on a pod is left alone.

const integration = testDatabaseUrl() ? describe : describe.skip;
const TIMEOUT_MS = 30_000;

const catalogProfile = (
  models: string[],
  families: NonNullable<CatalogProfile["model_families"]>,
): CatalogProfile => ({
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: models[0] ?? "sonnet-5-1",
  models,
  model_families: families,
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
});

const SERIES = {
  "sonnet-5-0": { family: "sonnet", rank: 0 },
  "sonnet-5-1": { family: "sonnet", rank: 1 },
  "haiku-5-0": { family: "haiku", rank: 0 },
};

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

  const gatewayFor = (profile: CatalogProfile) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: withSeededInstallation({
        profiles: { p: profile },
        repositories: {
          app: {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["p"],
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

  // Waiting for a turn on `model`, pinned to `profile` as it was created.
  async function waiting(
    partition: string,
    model: string,
    profile: CatalogProfile,
  ) {
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: `owner-${crypto.randomUUID()}` },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "p",
      repository: {
        id: "app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const id = accepted.response.session_id;
    await db
      .update(sessions)
      .set({
        partition,
        model,
        profileFingerprint: profileFingerprint(profile),
      })
      .where(eq(sessions.id, id));
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
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `move-${crypto.randomUUID()}`;
      const id = await waiting(partition, "sonnet-5-0", profile);
      const launch = await launchSession(db, { sessionId: id });

      const claimed = await claimOf(gatewayFor(profile), launch);

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

  test(
    "a family with nothing newer listed stays blocked and nothing moves",
    async () => {
      // Created on sonnet-5-0; only an older sonnet and another family remain.
      const before = catalogProfile(["sonnet-5-0", "haiku-5-0"], SERIES);
      const after = catalogProfile(["haiku-5-0"], SERIES);
      const partition = `block-${crypto.randomUUID()}`;
      const id = await waiting(partition, "sonnet-5-0", before);
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
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pod-${crypto.randomUUID()}`;
      const running = await waiting(partition, "sonnet-5-1", profile);
      const runningLaunch = await launchSession(db, { sessionId: running });
      await claimOf(gatewayFor(profile), runningLaunch);
      // Its model leaves the list while the turn runs.
      await db
        .update(sessions)
        .set({ model: "sonnet-5-0" })
        .where(eq(sessions.id, running));

      const other = await waiting(partition, "sonnet-5-0", profile);
      const otherLaunch = await launchSession(db, { sessionId: other });
      await claimOf(gatewayFor(profile), otherLaunch);

      expect((await rowOf(other)).model).toBe("sonnet-5-1");
      expect((await rowOf(running)).model).toBe("sonnet-5-0");
      expect(await migrations(running)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a partition-wide pass moves the waiting session and skips the one on a pod, even when both are signalled",
    async () => {
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pass-${crypto.randomUUID()}`;
      const onPod = await waiting(partition, "sonnet-5-0", profile);
      const idle = await waiting(partition, "sonnet-5-0", profile);
      // Signalled like the idle one, but a worker holds it: only the pod
      // guard keeps it out of the move.
      await db
        .update(sessions)
        .set({ podId: crypto.randomUUID() })
        .where(eq(sessions.id, onPod));
      const moves = modelMovePins(profile, [])
        .filter((pin) => pin.from === "sonnet-5-0")
        .map((pin) => ({ profileId: "p", ...pin }));

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
    "a session pinned by a version 1 fingerprint, its model column empty, moves with its pin",
    async () => {
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const v1 = modelMovePins(profile, []).find(
        (pin) =>
          pin.from === "sonnet-5-0" &&
          pin.fromFingerprint !== pin.toFingerprint,
      );
      if (!v1) throw new Error("no version 1 pin");
      const id = await waiting(`v1-${crypto.randomUUID()}`, "x", profile);
      const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
      await db
        .update(sessions)
        .set({ model: null, profileFingerprint: v1.fromFingerprint })
        .where(eq(sessions.id, row?.id ?? id));
      const launch = await launchSession(db, { sessionId: id });

      const claimed = await claimOf(gatewayFor(profile), launch);

      expect(claimed.runtime_config.model).toBe("sonnet-5-1");
      const moved = await rowOf(id);
      expect(moved.model).toBe("sonnet-5-1");
      expect(moved.profileFingerprint).toBe(v1.toFingerprint);
      expect(await migrations(id)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a session another transaction holds at claim is waited for, not given up on",
    async () => {
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const id = await waiting(
        `lock-${crypto.randomUUID()}`,
        "sonnet-5-0",
        profile,
      );
      const launch = await launchSession(db, { sessionId: id });
      // An input append holds the row while the claim runs.
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
          id,
        ]);
        const claiming = claimOf(gatewayFor(profile), launch);
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
