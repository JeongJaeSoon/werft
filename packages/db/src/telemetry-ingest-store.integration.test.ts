import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createWorkerGateway,
  hashWorkerToken,
  withSeededInstallation,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { revokeExecutionAtomic } from "./execution-revocation.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions, unassignedSessions } from "./schema.ts";
import { createPostgresTelemetryIngestStore } from "./telemetry-ingest-store.ts";
import { launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("telemetry ingest store on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "telemetry_ingest_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: withSeededInstallation({
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
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
          },
        },
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            profiles: ["claude-coding-v1"],
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
        leaseTtlMs: 5_000,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function runningSession() {
    const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: `owner-${crypto.randomUUID()}` },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    const partition = `telemetry-${crypto.randomUUID()}`;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const launch = await launchSession(db, { sessionId });
    const claimed = await gateway.bootstrapClaim(bootstrap, {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    });
    const principal: WorkerPrincipal = {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
    await gateway.nextInput(principal, {
      session_id: claimed.session_id,
      turn_id: null,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    });
    return { sessionId, claimed, launch };
  }

  test("a live credential resolves held with the turns its attempt was handed", async () => {
    const store = createPostgresTelemetryIngestStore(db);
    const { sessionId, claimed, launch } = await runningSession();

    const record = await store.attemptOfCredential(
      hashWorkerToken(claimed.session_credential),
    );
    expect(record).toMatchObject({
      sessionId,
      attemptId: claimed.attempt_id,
      executionId: launch.executionId,
      held: true,
      lostForMs: 0,
    });
    expect(await store.turnSequencesOf(claimed.attempt_id)).toEqual([1]);
    expect(
      await store.attemptOfCredential(hashWorkerToken("not-a-credential")),
    ).toBeNull();
  });

  test("a revoked execution's credential is still resolved, as lost", async () => {
    const store = createPostgresTelemetryIngestStore(db);
    const { sessionId, claimed } = await runningSession();
    await revokeExecutionAtomic(db, {
      sessionId,
      reason: "grant revoked",
      now: new Date(),
    });
    await Bun.sleep(20);

    const record = await store.attemptOfCredential(
      hashWorkerToken(claimed.session_credential),
    );
    expect(record?.held).toBe(false);
    expect(record?.lostForMs).toBeGreaterThan(0);
    expect(record?.lostForMs).toBeLessThan(60_000);
  });
});
