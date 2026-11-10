import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  createWorkerGateway,
  modelMovePins,
  profileFingerprint,
  releaseSpecRecord,
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
  TEST_CONNECTION_ID,
  TEST_MODEL,
  fixtureRelease,
  releaseSpecColumns,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import {
  createPostgresWorkerUnitOfWork,
  moveSessionsToSuccessors,
} from "./worker-unit-of-work.ts";

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

  const gatewayFor = (profile: CatalogProfile) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testSessionCatalog({
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
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
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

  async function ofAgent(sessionId: string, autoModelMigration: boolean) {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      const scoped = drizzle(client, { schema });
      const agentId = crypto.randomUUID();
      const releaseId = `rel-${crypto.randomUUID()}`;
      await scoped.insert(agents).values({
        id: agentId,
        workspaceId: crypto.randomUUID(),
        managingTeamId: crypto.randomUUID(),
        slug: `a-${agentId.slice(0, 8)}`,
        name: "agent",
        autoModelMigration,
      });
      await scoped.insert(agentReleases).values({
        id: releaseId,
        agentId,
        versionId: crypto.randomUUID(),
        cardSha256: "0".repeat(64),
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: { tools: [], mcp: [] },
      });
      await scoped
        .update(sessions)
        .set({ agentReleaseId: releaseId })
        .where(eq(sessions.id, sessionId));
      return agentId;
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
  }

  test(
    "a session of an agent that switched the move off stays blocked where it is, and one of an agent that left it on moves",
    async () => {
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `optout-${crypto.randomUUID()}`;
      const off = await waiting(partition, "sonnet-5-0", profile);
      await ofAgent(off, false);
      const on = await waiting(partition, "sonnet-5-0", profile);
      await ofAgent(on, true);

      const offLaunch = await launchSession(db, { sessionId: off });
      await expect(
        claimOf(gatewayFor(profile), offLaunch),
      ).rejects.toBeDefined();
      expect((await rowOf(off)).model).toBe("sonnet-5-0");
      expect(await migrations(off)).toEqual([]);

      const onLaunch = await launchSession(db, { sessionId: on });
      await claimOf(gatewayFor(profile), onLaunch);
      expect((await rowOf(on)).model).toBe("sonnet-5-1");
      expect(await migrations(on)).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "a family with nothing newer listed stays blocked and nothing moves",
    async () => {
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
    "a moved session's spec pin follows its model in the same statement, the release's stays, and an unpinned session stays unpinned",
    async () => {
      const profile = catalogProfile(["sonnet-5-1", "haiku-5-0"], SERIES);
      const partition = `pin-${crypto.randomUUID()}`;
      const pinned = await waiting(partition, "sonnet-5-0", profile);
      const bare = await waiting(partition, "sonnet-5-0", profile);
      const releaseId = `rel-${crypto.randomUUID()}`;
      const record = releaseSpecRecord({
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
      const client = await pool.connect();
      try {
        await client.query("SET session_replication_role = replica");
        const scoped = drizzle(client, { schema });
        await scoped.insert(agentReleases).values({
          id: releaseId,
          agentId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          cardSha256: "0".repeat(64),
          connectionId: TEST_CONNECTION_ID,
          ...releaseSpecColumns(),
          runtimeConfigSnapshot: {},
          effectiveTools: { tools: [], mcp: [] },
          specSource: record.spec_source,
          specSourceDigest: record.spec_source_digest,
          runtimeSpec: record.runtime_spec,
          specDigest: record.spec_digest,
        });
        await scoped
          .update(sessions)
          .set({
            agentReleaseId: releaseId,
            specSource: record.spec_source,
            specSourceDigest: record.spec_source_digest,
            runtimeSpec: record.runtime_spec,
            specDigest: record.spec_digest,
          })
          .where(eq(sessions.id, pinned));
        await scoped
          .update(sessions)
          .set({ agentReleaseId: releaseId })
          .where(eq(sessions.id, bare));
      } finally {
        await client.query("SET session_replication_role = DEFAULT");
        client.release();
      }
      const moves = modelMovePins(profile, [])
        .filter((pin) => pin.from === "sonnet-5-0")
        .map((pin) => ({ profileId: "p", ...pin }));

      await db.transaction((tx) =>
        moveSessionsToSuccessors(
          tx,
          { partition, sessionId: null },
          { modelMoves: moves, now: new Date() },
        ),
      );

      const after = await rowOf(pinned);
      expect(after.model).toBe("sonnet-5-1");
      expect(after.runtimeSpec?.model).toBe("sonnet-5-1");
      expect(after.specSource?.model).toBe("sonnet-5-1");
      expect(verifyReleaseSpec(releaseId, snakeSpec(after)).ok).toBe(true);
      const [release] = await db
        .select()
        .from(agentReleases)
        .where(eq(agentReleases.id, releaseId));
      expect(release?.specDigest).toBe(record.spec_digest);
      expect(release?.specSource?.model).toBe("sonnet-5-0");
      const other = await rowOf(bare);
      expect(other.model).toBe("sonnet-5-1");
      expect(other.specSource).toBeNull();
    },
    TIMEOUT_MS,
  );

  test(
    "a new session of a release with a verified spec starts with it under its own model, and one of a release without starts unpinned",
    async () => {
      const withSpec = `rel-${crypto.randomUUID()}`;
      const without = `rel-${crypto.randomUUID()}`;
      const record = releaseSpecRecord({
        derivation_version: 1,
        origin: "agent",
        release_id: withSpec,
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
      const client = await pool.connect();
      try {
        await client.query("SET session_replication_role = replica");
        const scoped = drizzle(client, { schema });
        for (const id of [withSpec, without]) {
          await scoped.insert(agentReleases).values({
            id,
            agentId: crypto.randomUUID(),
            versionId: crypto.randomUUID(),
            cardSha256: "0".repeat(64),
            connectionId: TEST_CONNECTION_ID,
            ...releaseSpecColumns(),
            runtimeConfigSnapshot: {},
            effectiveTools: { tools: [], mcp: [] },
            ...(id === withSpec
              ? {
                  specSource: record.spec_source,
                  specSourceDigest: record.spec_source_digest,
                  runtimeSpec: record.runtime_spec,
                  specDigest: record.spec_digest,
                }
              : {}),
          });
        }
      } finally {
        await client.query("SET session_replication_role = DEFAULT");
        client.release();
      }
      const start = async (releaseId: string) => {
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
          model: TEST_MODEL,
          repository: "none",
          model: "sonnet-5-1",
          agentReleaseId: releaseId,
          message: "go",
        });
        if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
        return rowOf(accepted.response.session_id);
      };

      const pinned = await start(withSpec);
      expect(pinned.specSource?.model).toBe("sonnet-5-1");
      expect(pinned.specSource?.release_id).toBe(withSpec);
      expect(verifyReleaseSpec(withSpec, snakeSpec(pinned)).ok).toBe(true);
      const bare = await start(without);
      expect(bare.specSource).toBeNull();
      expect(bare.specDigest).toBeNull();
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
