import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  WORKER_LEASE_SAFETY_MARGIN_MS,
  type WorkerEvent,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  createWorkerGateway,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_NONCE_TTL_MS,
  type GitHubGrant,
  hashWorkerToken,
  type NeutralizeEvent,
  profileFingerprint,
  recordedPointer,
  transcriptWarnBytes,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { readPointerRuntime } from "./checkpoint-runtime.ts";
import { createPostgresCheckpointStore } from "./checkpoint-store.ts";
import { fromDbNow } from "./db-clock.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import { pauseBlocker } from "./pause-control.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { reconcileOrphanedSessions } from "./queries.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  achievementCategories,
  achievementJudgments,
  achievementRules,
  achievementTypes,
  attempts,
  checkpointOutputs,
  checkpoints,
  events,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  users,
  workerCredentials,
  workerImageRefusals,
  workerLaunches,
  workers,
  workspaces,
} from "./schema.ts";
import { commitCheckpoint } from "./testing/checkpoints.ts";
import {
  confirmExecutionGone,
  insertUnreservedLaunch,
  launchSession,
  type TestLaunch,
} from "./testing/launches.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  TEST_MODEL,
  fixtureRelease,
  releaseSpecSqlValues,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import {
  CHECKPOINT_RESTORE_FALLBACK,
  createPostgresWorkerUnitOfWork,
} from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

// The worker's own numbered stream, without the status events the control
// plane writes beside it at each turn boundary.
function workerStream(sessionId: string) {
  return and(eq(events.sessionId, sessionId), isNotNull(events.sourceSequence));
}

const LEASE_TTL_MS = 2_000;
const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const VERIFIED_RUNTIME = {
  cliVersion: "2.1.270",
  engine: "claude-agent-sdk",
  profileSha256: "b".repeat(64),
  sdkVersion: "0.3.270",
};
const NEXT_RUNTIME = {
  cliVersion: "2.1.280",
  engine: "claude-agent-sdk-next",
  profileSha256: "c".repeat(64),
  sdkVersion: "0.3.280",
};

integration("worker gateway on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let clock = new Date("2026-09-22T00:00:00.000Z");
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "worker_gw_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      github: {
        grant: async () =>
          ({
            gitCredential: {
              username: "x-access-token",
              password: "fixture-app-issued",
            },
          }) as GitHubGrant,
      },
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
        models: ["claude-sonnet-5"],
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: {
        async verify({ checkpoint }) {
          if (checkpoint.manifest_ref.startsWith("bad/")) {
            return { status: "rejected", reason: "hash mismatch" };
          }
          // Stand-ins for what the storage-backed verifier reads off the
          // manifest: a transcript past the limits, or the total it pins.
          if (checkpoint.manifest_ref.startsWith("over-limit/")) {
            return {
              status: "rejected",
              reason: "the transcript is over the limit",
              limit: "transcript_too_large",
            };
          }
          if (checkpoint.manifest_ref.startsWith("outputs/")) {
            return {
              status: "verified",
              outputs: [
                { key: `${checkpoint.manifest_ref}/a`, bytes: 7 },
                { key: "outputs/inherited", bytes: 11 },
              ],
              outputsDigest: "d".repeat(64),
            };
          }
          if (checkpoint.manifest_ref.startsWith("runtime/")) {
            return { status: "verified", runtime: VERIFIED_RUNTIME };
          }
          if (checkpoint.manifest_ref.startsWith("runtime-next/")) {
            return { status: "verified", runtime: NEXT_RUNTIME };
          }
          const sized = /\/bytes-(\d+)\//.exec(checkpoint.manifest_ref);
          return sized === null
            ? { status: "verified" }
            : { status: "verified", transcriptBytes: Number(sized[1]) };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: LEASE_TTL_MS,
        now,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const briefGateway = (leaseTtlMs: number, neutralize?: NeutralizeEvent) =>
    createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      ...(neutralize === undefined ? {} : { neutralize }),
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
        models: ["claude-sonnet-5"],
        repositories: {
          "sample-app": {
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
        leaseTtlMs,
        now: () => clock,
        sleep: async () => {},
      },
    });

  function launch(sessionId: string) {
    return launchSession(db, { sessionId });
  }

  // Every test owns a partition so leftovers from other tests never compete.
  async function queuedSession(
    partition: string,
    message = "first input",
    ownerId = `owner-${crypto.randomUUID()}`,
  ) {
    const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, result.response.session_id));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, result.response.session_id));
    return result.response;
  }

  function partitionFor(name: string) {
    return `${name}-${crypto.randomUUID()}`;
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Lease and token expiry are judged on the database clock, so assertions
  // about them bracket the call with that clock, never the injected one.
  async function dbNowMs() {
    const [row] = await db
      .select({
        ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
      })
      .from(sql`(SELECT 1) AS one`);
    return Number(row?.ms);
  }

  // Steps that must succeed run under the full LEASE_TTL_MS, so a loaded
  // runner cannot spend the lease before they reach the fence. A test about
  // expiry then pulls the deadline in on the database clock, which judges it.
  async function leaseEndsIn(attemptId: string, ms: number) {
    const [row] = await db
      .update(attempts)
      .set({ leaseExpiresAt: fromDbNow(ms) })
      .where(eq(attempts.id, attemptId))
      .returning({ leaseExpiresAt: attempts.leaseExpiresAt });
    if (!row) throw new Error("attempt vanished");
    return row.leaseExpiresAt.getTime();
  }

  // A gateway whose request clock runs `offsetMs` from this machine's: the
  // replica-skew case the database clock exists to make irrelevant.
  const skewedGateway = (offsetMs: number, leaseTtlMs: number) =>
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
        models: ["claude-sonnet-5"],
        repositories: {
          "sample-app": {
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
        leaseTtlMs,
        now: () => new Date(Date.now() + offsetMs),
        sleep: async () => {},
      },
    });

  function claim(l: Awaited<ReturnType<typeof launch>>) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  function scopeOf(
    claimed: Awaited<ReturnType<typeof claim>>,
    turnId: string | null = null,
  ): WorkerScope {
    return {
      session_id: claimed.session_id,
      turn_id: turnId,
      attempt_id: claimed.attempt_id,
      lease_epoch: claimed.lease_epoch,
      execution_generation: claimed.execution_generation,
      auth_revision: claimed.auth_revision,
    };
  }

  function principalOf(
    claimed: Awaited<ReturnType<typeof claim>>,
  ): WorkerPrincipal {
    return {
      kind: "session",
      attemptId: claimed.attempt_id,
      sessionId: claimed.session_id,
      leaseEpoch: claimed.lease_epoch,
      executionGeneration: claimed.execution_generation,
      authRevision: claimed.auth_revision,
    };
  }

  function fenceOf(claimed: Awaited<ReturnType<typeof claim>>) {
    const { kind: _kind, ...fence } = principalOf(claimed) as Extract<
      WorkerPrincipal,
      { kind: "session" }
    >;
    return fence;
  }

  async function failure(work: Promise<unknown>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        return { status: error.status, code: error.code };
      }
      throw error;
    }
    throw new Error("expected the call to fail");
  }

  function event(sourceSequence: number): WorkerEvent {
    return {
      event: "status",
      data: { phase: "running" },
      source_sequence: sourceSequence,
      occurred_at: clock.toISOString(),
    };
  }

  // Runs a full attempt so later tests start from a clean queue head.
  async function claimAndDeliver(
    partition = partitionFor("run"),
    ownerId?: string,
  ) {
    const session = await queuedSession(partition, undefined, ownerId);
    const l = await launch(session.session_id);
    const claimed = await claim(l);
    expect(claimed.session_id).toBe(session.session_id);
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    if (!next.input) throw new Error("no input delivered");
    return { session, launch: l, claimed, input: next.input };
  }

  test("bootstrapClaim binds one unassigned session per launch and replays the same binding", async () => {
    const partition = partitionFor("bind");
    const session = await queuedSession(partition);
    const l = await launch(session.session_id);
    const first = await claim(l);
    expect(first.session_id).toBe(session.session_id);
    expect(first.lease_epoch).toBe(1);
    expect(first.execution_generation).toBe(1);
    expect(first.runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: "claude-coding-v1",
    });
    expect(first.restore).toBeNull();
    expect(first.session_credential.startsWith("wsc_")).toBe(true);
    // The repository comes from the row, bound only because the catalog
    // still registers that id at that URL and branch for this profile. The
    // profile comes from the catalog, resolved at claim time.
    expect(first.workspace).toEqual({
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
        access: { kind: "egress_token", token: expect.stringMatching(/^wer_/) },
      },
    });
    // The provider key stays on the server; the worker gets the
    // upstream's name and a token for the egress proxy's route.
    expect(first.runtime_config).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: { kind: "egress_token", token: expect.stringMatching(/^wep_/) },
      },
    });
    expect(JSON.stringify(first)).not.toContain("catalog-provider-key");

    const retry = await claim(l);
    expect(retry.session_id).toBe(first.session_id);
    expect(retry.attempt_id).toBe(first.attempt_id);
    expect(retry.lease_epoch).toBe(first.lease_epoch);
    expect(retry.session_credential).not.toBe(first.session_credential);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.podId).toBe(l.executionId);
    expect(row?.executionId).toBe(l.executionId);
    const signals = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signals).toHaveLength(0);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, first.attempt_id));
    expect(attempt?.state).toBe("allocated");
    // The replayed claim rotated the token: only the latest one resolves.
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).toBeNull();
    expect(
      await work.resolveCredential(hashWorkerToken(retry.session_credential)),
    ).toEqual({
      kind: "session",
      attemptId: first.attempt_id,
      sessionId: first.session_id,
      profileId: "claude-coding-v1",
      leaseEpoch: retry.lease_epoch,
      executionGeneration: retry.execution_generation,
      authRevision: retry.auth_revision,
    });
  });

  test("egress tokens live and die with the attempt, each for its own route only", async () => {
    const partition = partitionFor("egress");
    const session = await queuedSession(partition);
    const l = await launch(session.session_id);
    const first = await claim(l);
    const providerOf = (claimed: typeof first) =>
      claimed.runtime_config.provider.auth.token;
    const repositoryOf = (claimed: typeof first) =>
      claimed.workspace.repository?.access?.token ?? "";
    const authorize = (token: string, purpose: "provider" | "repository") =>
      failure(gateway.authorizeEgress({ token, purpose }));

    // A lost claim response is replayed with fresh tokens, and the old ones
    // are revoked with the old session credential.
    const retry = await claim(l);
    expect(providerOf(retry)).not.toBe(providerOf(first));
    expect(await authorize(providerOf(first), "provider")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await authorize(repositoryOf(first), "repository")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });

    // The live ones answer for their own route, with the claim's upstream.
    const provider = await gateway.authorizeEgress({
      token: providerOf(retry),
      purpose: "provider",
    });
    expect(provider).toEqual({
      session_id: session.session_id,
      attempt_id: retry.attempt_id,
      upstream: {
        url: "https://litellm.invalid",
        headers: [["x-api-key", "catalog-provider-key"]],
      },
    });
    expect(
      await gateway.authorizeEgress({
        token: repositoryOf(retry),
        purpose: "repository",
      }),
    ).toEqual({
      session_id: session.session_id,
      attempt_id: retry.attempt_id,
      upstream: {
        url: "https://example.invalid/app.git",
        headers: [
          [
            "authorization",
            `Basic ${Buffer.from("x-access-token:fixture-app-issued").toString("base64")}`,
          ],
        ],
      },
    });
    // Using a token is using the binding: the claim can no longer be
    // replayed out from under the worker that is already cloning with it.
    const [started] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, retry.attempt_id));
    expect(started?.state).toBe("starting");
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });

    // No token crosses purposes: not between the two routes, not into the
    // gateway, and the session credential is not an egress token.
    expect(await authorize(providerOf(retry), "repository")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await authorize(repositoryOf(retry), "provider")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await authorize(retry.session_credential, "provider")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    for (const token of [providerOf(retry), repositoryOf(retry)]) {
      expect(await failure(gateway.authenticate(token))).toEqual({
        status: 401,
        code: "UNAUTHORIZED",
      });
    }

    // A heartbeat extends all five together.
    await gateway.heartbeat(principalOf(retry), {
      ...scopeOf(retry),
      attempt_state: "draining",
    });
    const live = await pool.query(
      "SELECT purpose, expires_at FROM worker_credentials WHERE attempt_id = $1 AND revoked_at IS NULL ORDER BY purpose",
      [retry.attempt_id],
    );
    expect(live.rows.map((row) => row.purpose)).toEqual([
      "gateway",
      "object_store",
      "packages",
      "provider",
      "repository",
    ]);
    expect(new Set(live.rows.map((row) => String(row.expires_at))).size).toBe(
      1,
    );
    // A draining attempt still owns its session and still needs the provider
    // to finish its turn.
    expect(
      (
        await gateway.authorizeEgress({
          token: providerOf(retry),
          purpose: "provider",
        })
      ).attempt_id,
    ).toBe(retry.attempt_id);

    // Ownership moving is enough, before anything revokes a token: here the
    // session's fence moves on without this attempt.
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    expect(await authorize(providerOf(retry), "provider")).toEqual({
      status: 403,
      code: "FORBIDDEN",
    });
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} - 1` })
      .where(eq(sessions.id, session.session_id));

    // A lease that ran out is refused while the token itself is unexpired:
    // the reconciler may not have got to it yet, and the proxy must not
    // wait for it.
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(attempts.id, retry.attempt_id));
    expect(await authorize(providerOf(retry), "provider")).toEqual({
      status: 403,
      code: "FORBIDDEN",
    });
    await db
      .update(attempts)
      .set({ leaseExpiresAt: sql`clock_timestamp() + interval '1 minute'` })
      .where(eq(attempts.id, retry.attempt_id));

    // A release ends the attempt and revokes every token it held.
    await gateway.release(principalOf(retry), {
      ...scopeOf(retry),
      reason: "idle_timeout",
    });
    expect(await authorize(providerOf(retry), "provider")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await authorize(repositoryOf(retry), "repository")).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("release GitHub settings remain readable by the gate across release changes", async () => {
    const session = await queuedSession(partitionFor("github-pins"));
    const claimed = await claim(await launch(session.session_id));
    const token = claimed.workspace.repository?.access?.token ?? "";
    const workspaceId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', (SELECT id FROM t))",
      [agentId, workspaceId],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    const release = (pins: object) =>
      pool
        .query(
          `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
             repository_id, runtime_config_snapshot, effective_tools,
             policy_pins, ${RELEASE_SPEC_SQL_COLUMNS})
           VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', $5, ${releaseSpecSqlValues()})
           RETURNING id`,
          [
            `sha256:${crypto.randomUUID()}`,
            agentId,
            versionId,
            "a".repeat(64),
            JSON.stringify(pins),
          ],
        )
        .then(({ rows }) => rows[0].id as string);
    const pinTo = (releaseId: string) =>
      db
        .update(sessions)
        .set({ agentReleaseId: releaseId })
        .where(eq(sessions.id, session.session_id));
    const repository = () =>
      gateway.authorizeEgress({ token, purpose: "repository" });

    // What the GitHub gate reads for every token it issues.
    const gate = createPostgresGitHubGateStore(db);

    expect((await gate.context(session.session_id))?.release).toBeNull();
    // As accepted and as the gateway compares it to the catalog entry.
    expect((await gate.context(session.session_id))?.repository).toEqual({
      url: "https://example.invalid/app.git",
      branch: "main",
    });
    await pinTo(await release({}));
    expect((await gate.context(session.session_id))?.policy.settings).toBe(
      null,
    );
    expect((await repository()).attempt_id).toBe(claimed.attempt_id);
    // The stub isolates persistence here; gate tests cover policy refusal.
    await pinTo(await release({ github: { from: "a later server" } }));
    expect((await gate.context(session.session_id))?.policy.settings).toBe(
      "invalid",
    );
    expect((await repository()).attempt_id).toBe(claimed.attempt_id);
    // The provider route is not GitHub's and stays open.
    expect(
      (
        await gateway.authorizeEgress({
          token: claimed.runtime_config.provider.auth.token,
          purpose: "provider",
        })
      ).attempt_id,
    ).toBe(claimed.attempt_id);
  });

  test("a nonce is rejected for another execution identity, when expired, and when unknown", async () => {
    const partition = partitionFor("nonce");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: "someone-else",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: 2,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    expect(
      await failure(
        gateway.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "wln_unknown" },
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("the same nonce presented by two workers concurrently yields one binding and one live token", async () => {
    const partition = partitionFor("leak");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const [x, y] = await Promise.all([claim(l), claim(l)]);
    expect(x.attempt_id).toBe(y.attempt_id);
    expect(x.session_id).toBe(y.session_id);
    const work = createPostgresWorkerUnitOfWork(db);
    const live = (
      await Promise.all(
        [x, y].map((c) =>
          work.resolveCredential(hashWorkerToken(c.session_credential)),
        ),
      )
    ).filter(Boolean);
    expect(live).toHaveLength(1);
  });

  test("bootstrap credentials cannot call post-claim methods, nor can a token for another binding", async () => {
    const { claimed } = await claimAndDeliver();
    expect(
      await failure(gateway.nextInput(bootstrap, scopeOf(claimed))),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    const other = await claimAndDeliver();
    expect(
      await failure(
        gateway.heartbeat(principalOf(other.claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("nextInput tells a turn queued with the old directive wording as facts whoever queued it, and keeps a message that only starts like it", async () => {
    const subject = "push request p1 (repository app, branch agent/s1)";
    const legacy = `Platform note: a person approved ${subject} in Slack. The push runs in the background: call open_pull_request now, and if it answers not_pushed, wait a few seconds and call it again. Then finish what you were asked to do.`;
    const fact = `A person approved ${subject}. The push runs in the background.`;
    const pasted = `${legacy}\nPlease explain why this is wrong; do not open a PR.`;
    // The Slack path queues it as the approver, the platform's own as no one.
    for (const [actor, message, expected] of [
      [null, legacy, fact],
      ["approver", legacy, fact],
      ["person", pasted, pasted],
    ] as const) {
      const session = await queuedSession(partitionFor(`legacy-${actor}`));
      const l = await launch(session.session_id);
      const claimed = await claim(l);
      const userId = actor === null ? null : crypto.randomUUID();
      if (userId !== null) {
        await db.insert(users).values({
          id: userId,
          email: `${userId}@example.invalid`,
          passwordHash: "argon2id$placeholder",
          displayName: "queued by",
        });
      }
      await db
        .update(turns)
        .set({ message, actorId: userId })
        .where(eq(turns.sessionId, session.session_id));
      const next = await gateway.nextInput(principalOf(claimed), {
        ...scopeOf(claimed),
      });
      expect(next.input?.message).toBe(expected);
    }
  });

  test("nextInput delivers the FIFO head once, records delivery_started_at and redelivers to the same attempt", async () => {
    const { session, claimed, input } = await claimAndDeliver();
    expect(input.turn_id).toBe("1");
    expect(input.message).toBe("first input");
    const [turn] = await db
      .select()
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("running");
    expect(turn?.attemptId).toBe(claimed.attempt_id);
    expect(turn?.deliveryStartedAt?.toISOString()).toBe(
      input.delivery_started_at,
    );
    const [message] = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(message?.claimedBy).toBe(claimed.attempt_id);
    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("running");

    advance(500);
    const again = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(again.input).toEqual(input);
  });

  test("heartbeat extends the lease and answers 409 LEASE_EXPIRED once the TTL passed", async () => {
    const partition = partitionFor("beat");
    const queued = await queuedSession(partition);
    const claimed = await claim(await launch(queued.session_id));
    await gateway.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    const before = new Date(claimed.lease_expires_at).getTime();
    await sleep(100);
    const floor = await dbNowMs();
    advance(1_000);
    const beat = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const ceiling = await dbNowMs();
    const extended = new Date(beat.lease_expires_at).getTime();
    // The new deadline is the database clock plus the TTL, not the request
    // clock the gateway was handed.
    expect(extended).toBeGreaterThanOrEqual(floor + LEASE_TTL_MS);
    expect(extended).toBeLessThanOrEqual(ceiling + LEASE_TTL_MS);
    expect(extended).toBeGreaterThan(before);
    expect(beat.auth_revision).toBe(0);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    // Audit stamps still record the request clock.
    expect(attempt?.lastHeartbeatAt?.toISOString()).toBe(clock.toISOString());
    expect(attempt?.state).toBe("running");

    // The request clock does not move: only real time ends the lease.
    await leaseEndsIn(claimed.attempt_id, 300);
    await sleep(350);
    expect(
      await failure(
        gateway.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b1",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    // Giving the binding up is still allowed on the current epoch.
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "lease_lost",
      }),
    ).toEqual({ released: true });
  });

  test("appendEvents dedups on (attempt_id, source_sequence); a re-sent batch is a no-op", async () => {
    const { session, claimed } = await claimAndDeliver();
    const request = {
      ...scopeOf(claimed, "1"),
      batch_key: "batch-1",
      events: [event(1), event(2)],
    };
    const first = await gateway.appendEvents(principalOf(claimed), request);
    expect(first.accepted_through).toBe(2);
    const second = await gateway.appendEvents(principalOf(claimed), request);
    expect(second).toEqual(first);
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(storedRow?.stored).toBe(2);
    const [row] = await db
      .select()
      .from(events)
      .where(workerStream(session.session_id))
      .limit(1);
    expect(row?.attemptId).toBe(claimed.attempt_id);
    expect(row?.turnId).not.toBeNull();
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...request,
          turn_id: "42",
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("a nonce stops working once its lifetime passes, including on the replay path", async () => {
    const partition = partitionFor("expiry");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const first = await claim(l);
    // The attempt is alive, but the bootstrap door closes with the nonce.
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    // The running worker keeps the token it already holds.
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).not.toBeNull();
  });

  test("a claim is refused once the backend has taken the launch slot back", async () => {
    const partition = partitionFor("slotgone");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    // The execution died before claiming; the backend observed it.
    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("events are refused for a turn this attempt is not running", async () => {
    const partition = partitionFor("foreign");
    const session = await queuedSession(partition);
    const owner = (
      await db
        .select({ ownerId: sessions.ownerId })
        .from(sessions)
        .where(eq(sessions.id, session.session_id))
    )[0];
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: owner?.ownerId ?? "" },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "queued behind the head",
    });
    const l = await launch(session.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    // Turn 2 exists and belongs to the session, but no attempt runs it.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "2"),
          batch_key: "b",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    // An id past the integer column is not found, not a database error.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "9999999999"),
          batch_key: "b",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "9999999999"),
          turn_id: "9999999999",
          finalize_key: "f",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: null,
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("reusing a source_sequence with different content is a conflict, not a silent drop", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = {
      ...scopeOf(claimed, "1"),
      batch_key: "batch-1",
      events: [event(1)],
    };
    await gateway.appendEvents(principalOf(claimed), base);
    const changed: WorkerEvent = {
      event: "status",
      data: { phase: "needs_input" },
      source_sequence: 1,
      occurred_at: clock.toISOString(),
    };
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [changed],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // A batch that extends the stream around a matching replay still lands.
    const extended = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(1), event(2)],
    });
    expect(extended.accepted_through).toBe(2);
    // A batch that skips ahead is refused, not buffered: subscribers read the
    // stream back in the order it was written, so a hole would be permanent.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(4)],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    const closed = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(3), event(4)],
    });
    expect(closed.accepted_through).toBe(4);
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(storedRow?.stored).toBe(4);
  });

  test("a batch resent across replicas that do and do not store neutral fields is still the same batch", async () => {
    const { session, claimed } = await claimAndDeliver();
    // A rolling deploy: a replica that stores the neutral fields beside the
    // event and an older one that does not compare a resend the same way.
    const plain = briefGateway(LEASE_TTL_MS);
    const neutral = briefGateway(LEASE_TTL_MS, (_, e) =>
      e.event === "assistant" ? { ...e, data: { ...e.data, text: "hi" } } : e,
    );
    const said: WorkerEvent = {
      event: "assistant",
      data: { type: "assistant", message: { content: "hi" } },
      source_sequence: 1,
      occurred_at: clock.toISOString(),
    };
    const batch = {
      ...scopeOf(claimed, "1"),
      batch_key: "batch-1",
      events: [said],
    };
    await neutral.appendEvents(principalOf(claimed), batch);
    expect(
      (await plain.appendEvents(principalOf(claimed), batch)).accepted_through,
    ).toBe(1);
    expect(
      (await neutral.appendEvents(principalOf(claimed), batch))
        .accepted_through,
    ).toBe(1);
    const stored = await db.execute(
      sql`SELECT payload, neutral FROM events WHERE session_id = ${session.session_id} AND type = 'assistant'`,
    );
    expect(stored.rows).toEqual([
      { payload: said.data, neutral: { text: "hi" } },
    ]);
    // Fields the worker sent itself are the event: a change there is not a
    // resend.
    const own: WorkerEvent = {
      event: "assistant",
      data: { type: "assistant", text: "A" },
      source_sequence: 2,
      occurred_at: clock.toISOString(),
    };
    await neutral.appendEvents(principalOf(claimed), {
      ...batch,
      batch_key: "batch-2",
      events: [own],
    });
    expect(
      await failure(
        neutral.appendEvents(principalOf(claimed), {
          ...batch,
          batch_key: "batch-2",
          events: [{ ...own, data: { type: "assistant", text: "B" } }],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  test("finalize replayed with the same key but a different terminal is a conflict", async () => {
    const { claimed } = await claimAndDeliver();
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: { text: "done" },
        usage: null,
      },
      checkpoint: null,
    };
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          terminal: {
            status: "failed",
            reason: "different story",
            result: null,
            usage: null,
          },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // The stored terminal is what a true replay answers with.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
  });

  test("interrupted stops the session, outcome_unknown blocks it for recovery", async () => {
    const interrupted = await claimAndDeliver();
    await gateway.finalize(principalOf(interrupted.claimed), {
      ...scopeOf(interrupted.claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "interrupted",
        reason: "user_stop",
        result: null,
        usage: null,
      },
      // An interrupted terminal is only taken with the checkpoint it stopped at.
      checkpoint: {
        revision: 0,
        manifest_ref: "manifests/interrupted.json",
        manifest_sha256: "d".repeat(64),
      },
    });
    const [stopped] = await db
      .select({
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, interrupted.session.session_id));
    // An interrupt never takes the success/idle path.
    expect(stopped).toEqual({ status: "stopped", admissionState: "active" });
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, interrupted.session.session_id)),
    ).toHaveLength(0);

    const unknown = await claimAndDeliver();
    await gateway.finalize(principalOf(unknown.claimed), {
      ...scopeOf(unknown.claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "outcome_unknown",
        reason: "sdk_vanished",
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const [blocked] = await db
      .select({
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, unknown.session.session_id));
    expect(blocked).toEqual({
      status: "failed",
      admissionState: "recovery_required",
    });
    const [turn] = await db
      .select({ status: turns.status, outcomeUnknown: turns.outcomeUnknown })
      .from(turns)
      .where(eq(turns.sessionId, unknown.session.session_id));
    expect(turn).toEqual({ status: "outcome_unknown", outcomeUnknown: true });
    // The input stays on the queue until an operator decides, and
    // no attempt is handed it again.
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, unknown.session.session_id)),
    ).toHaveLength(1);
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, unknown.session.receipt_id));
    expect(receipt?.status).toBe("unknown");
    const again = await gateway.nextInput(
      principalOf(unknown.claimed),
      scopeOf(unknown.claimed),
    );
    expect(again.input).toBeNull();
  });

  test("the pod-based orphan reconciler leaves a gateway-bound session alone", async () => {
    const partition = partitionFor("reconcile");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    // The legacy reconciler keys on a missing/stale workers row. Left to it,
    // it would clear pod_id and requeue while the execution may still run.
    const reconciled = await reconcileOrphanedSessions(db, {
      now: new Date(clock.getTime() + 60_000),
    });
    expect(reconciled.map((row) => row.sessionId)).not.toContain(
      session.session_id,
    );
    const [row] = await db
      .select({ podId: sessions.podId, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.podId).toBe(l.executionId);
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.session_id)),
    ).toHaveLength(0);
    // Sanity: a pod-lifecycle session (no execution_id) is still reconciled.
    const legacy = await queuedSession(partitionFor("legacy"));
    await db
      .update(sessions)
      .set({ podId: `pod-${crypto.randomUUID()}` })
      .where(eq(sessions.id, legacy.session_id));
    const legacyRun = await reconcileOrphanedSessions(db, {
      now: new Date(clock.getTime() + 60_000),
    });
    expect(legacyRun.map((r) => r.sessionId)).toContain(legacy.session_id);
    await db.delete(workers).where(eq(workers.podId, l.executionId));
  });

  test("a claim replay is refused once the attempt has used its token", async () => {
    const partition = partitionFor("used");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const first = await claim(l);
    // nextInput is the worker using the binding: the claim response was not
    // lost, so a further exchange is someone else rotating the token away.
    await gateway.nextInput(principalOf(first), scopeOf(first));
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(first.session_credential)),
    ).not.toBeNull();
  });

  test("finalize cannot close a turn short of its event tail", async () => {
    const { session, claimed } = await claimAndDeliver();
    const scope = scopeOf(claimed, "1");
    await gateway.appendEvents(principalOf(claimed), {
      ...scope,
      batch_key: "b1",
      events: [event(1)],
    });
    const request = {
      ...scope,
      turn_id: "1",
      finalize_key: "fin-tail",
      final_source_sequence: 2,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    // Event 2 is still in flight: the turn stays open.
    expect(
      await failure(gateway.finalize(principalOf(claimed), request)),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    // Claiming less than is stored is refused the same way.
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          final_source_sequence: 0,
        }),
      ),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    const [open] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(open?.status).toBe("running");

    await gateway.appendEvents(principalOf(claimed), {
      ...scope,
      batch_key: "b2",
      events: [event(2)],
    });
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(done.status).toBe("completed");
    // A retry of the finalize that went through is still a replay.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
    // One naming another tail is not: the gate ran for the first one only.
    for (const other of [0, 100]) {
      expect(
        await failure(
          gateway.finalize(principalOf(claimed), {
            ...request,
            final_source_sequence: other,
          }),
        ),
      ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    }
  });

  test("occurred_at never goes back in id order across worker and control-plane writes", async () => {
    const { session, claimed } = await claimAndDeliver();
    const scope = scopeOf(claimed, "1");
    // A worker clock running ahead of the database's.
    const ahead = new Date(Date.now() + 60 * 60_000);
    await gateway.appendEvents(principalOf(claimed), {
      ...scope,
      batch_key: "ahead",
      events: [{ ...event(1), occurred_at: ahead.toISOString() }],
    });
    await gateway.finalize(principalOf(claimed), {
      ...scope,
      turn_id: "1",
      finalize_key: "fin-order",
      final_source_sequence: 1,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // A frame the engine emitted past its terminal, stamped before the
    // finalize committed and held behind it: stored after the idle status.
    const late = {
      ...scopeOf(claimed),
      batch_key: "late",
      events: [
        {
          event: "system" as const,
          data: { type: "system" as const, subtype: "late" },
          source_sequence: 2,
          occurred_at: new Date(ahead.getTime() - 300).toISOString(),
        },
      ],
    };
    await gateway.appendEvents(principalOf(claimed), late);
    // The worker resends its own time; the raised one still matches it.
    await gateway.appendEvents(principalOf(claimed), late);

    const rows = await db
      .select({
        type: events.type,
        payload: events.payload,
        at: events.occurredAt,
      })
      .from(events)
      .where(eq(events.sessionId, session.session_id))
      .orderBy(events.id);
    const times = rows.map((row) => row.at?.getTime() ?? Number.NaN);
    expect(times.every((at, i) => i === 0 || at >= (times[i - 1] ?? 0))).toBe(
      true,
    );
    const idle = rows.find(
      (row) =>
        row.type === "status" &&
        (row.payload as { phase?: string }).phase === "idle",
    );
    expect(idle?.at?.getTime()).toBe(ahead.getTime());
    expect(rows.at(-1)?.type).toBe("system");
    expect(rows.at(-1)?.at?.getTime()).toBe(ahead.getTime());
    expect(rows.filter((row) => row.type === "system")).toHaveLength(1);
  });

  test("append and finalize racing in either order never lose the tail", async () => {
    for (const round of [0, 1, 2, 3, 4, 5]) {
      const { session, claimed } = await claimAndDeliver();
      const scope = scopeOf(claimed, "1");
      const request = {
        ...scope,
        turn_id: "1",
        finalize_key: `race-${round}`,
        final_source_sequence: 2,
        terminal: {
          status: "completed" as const,
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      };
      const append = () =>
        gateway.appendEvents(principalOf(claimed), {
          ...scope,
          batch_key: `race-${round}`,
          events: [event(1), event(2)],
        });
      const finalize = () =>
        gateway.finalize(principalOf(claimed), request).then(
          () => "finalized" as const,
          (error: unknown) => {
            if (
              error instanceof WorkerGatewayError &&
              error.code === "REVISION_CONFLICT"
            ) {
              return "refused" as const;
            }
            throw error;
          },
        );
      // Alternate which request is sent first; the session lock decides.
      const [first] =
        round % 2 === 0
          ? await Promise.all([finalize(), append()])
          : await Promise.all([append(), finalize()]).then(
              ([, verdict]) => [verdict] as const,
            );
      // The append always lands: a finalize never closed the turn on it.
      if (first === "refused") {
        expect(await finalize()).toBe("finalized");
      }
      const [stored] = await db
        .select({ n: count() })
        .from(events)
        .where(workerStream(session.session_id));
      expect(stored?.n).toBe(2);
      const [closed] = await db
        .select({ status: turns.status })
        .from(turns)
        .where(
          and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
        );
      expect(closed?.status).toBe("completed");
    }
  });

  test("a rejected batch leaves the stream untouched and a closed turn takes no new events", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = { ...scopeOf(claimed, "1"), batch_key: "b" };
    await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(1)],
    });
    const changed: WorkerEvent = {
      event: "status",
      data: { phase: "idle" },
      source_sequence: 1,
      occurred_at: clock.toISOString(),
    };
    // A batch that mixes a conflicting replay with a new event must not
    // store the new one on its way to being rejected.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [changed, event(2)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // Two different events under one sequence in a single batch.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(3), { ...changed, source_sequence: 3 }],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    // The same sequence moved to another turn is not the same event.
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          turn_id: null,
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const [afterRejects] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(afterRejects?.stored).toBe(1);

    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 1,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // An exact replay still answers, a new event does not.
    expect(
      (
        await gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(1)],
        })
      ).accepted_through,
    ).toBe(1);
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(2)],
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const [afterFinalize] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(afterFinalize?.stored).toBe(1);
  });

  test("a batch that does not continue the durable prefix is refused", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = { ...scopeOf(claimed, "1"), batch_key: "b" };
    expect(
      await failure(
        gateway.appendEvents(principalOf(claimed), {
          ...base,
          events: [event(2), event(3)],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    const [empty] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(empty?.stored).toBe(0);
    // Inside one batch the order of arrival does not matter: the rows are
    // written by source_sequence, which is the order they are read back in.
    const ordered = await gateway.appendEvents(principalOf(claimed), {
      ...base,
      events: [event(3), event(1), event(2)],
    });
    expect(ordered.accepted_through).toBe(3);
    const stored = await db
      .select({ sourceSequence: events.sourceSequence })
      .from(events)
      .where(workerStream(session.session_id))
      .orderBy(events.id);
    expect(stored.map((row) => row.sourceSequence)).toEqual([1, 2, 3]);
  });

  test("a draining attempt is not handed the next input", async () => {
    const partition = partitionFor("drain");
    const { session, claimed } = await claimAndDeliver(partition);
    const scope = scopeOf(claimed, "1");
    await gateway.finalize(principalOf(claimed), {
      ...scope,
      turn_id: "1",
      finalize_key: "drain-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    const [owner] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: owner?.ownerId ?? "" },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "input the worker will not take",
    });
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "draining",
    });
    // The worker is on its way out, so the queued turn waits for the next
    // attempt instead of being delivered and then abandoned — and the poll
    // says so at once rather than holding the shutdown for its full wait.
    const polled = Date.now();
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
      wait_ms: 5_000,
    });
    expect(next.input).toBeNull();
    expect(Date.now() - polled).toBeLessThan(2_000);
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("draining");
    const [waiting] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 2)),
      );
    expect(waiting?.status).toBe("queued");
  });

  test("a heartbeat that commits late cannot shorten a lease already extended", async () => {
    const { claimed } = await claimAndDeliver();
    advance(500);
    const ahead = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const extended = new Date(ahead.lease_expires_at).getTime();
    const heartbeatAt = clock.getTime();
    // An overlapping heartbeat carrying an older request timestamp lands
    // second; it must not undo what the first one committed.
    advance(-400);
    const late = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    expect(new Date(late.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      extended,
    );
    const [attempt] = await db
      .select({
        leaseExpiresAt: attempts.leaseExpiresAt,
        lastHeartbeatAt: attempts.lastHeartbeatAt,
      })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(extended);
    expect(attempt?.lastHeartbeatAt?.getTime()).toBe(heartbeatAt);
    advance(400);
  });

  test("a checkpoint verification that outlives the lease commits nothing", async () => {
    const partition = partitionFor("slow");
    const session = await queuedSession(partition);
    const claimed = await claim(await launch(session.session_id));
    await gateway.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    await leaseEndsIn(claimed.attempt_id, 400);
    // The verifier is a network call. If it returns after the lease is gone,
    // the fence has to judge the commit by the clock at commit time.
    const slow = createWorkerGateway({
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
        models: ["claude-sonnet-5"],
        repositories: {
          "sample-app": {
            url: "https://example.invalid/app.git",
            branch: "main",
            auth: { kind: "github_app", registered: true },
          },
        },
      }),
      checkpoints: {
        async verify() {
          await sleep(500);
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 400,
        now: () => clock,
        sleep: async () => {},
      },
    });
    expect(
      await failure(
        slow.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          turn_id: "1",
          finalize_key: "slow-1",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 0,
            manifest_ref: "s3://bucket/m.json",
            manifest_sha256: "a".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("running");
    const [stored] = await db
      .select({ committed: count() })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(stored?.committed).toBe(0);
  });

  test("a session whose profile this host does not know is not claimed", async () => {
    const partition = partitionFor("profile");
    const session = await queuedSession(partition);
    // A pool worker: the host it lands on chooses among what is queued.
    const l = await insertUnreservedLaunch(db, { partition });
    const stranger = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
    // Running it on a guessed runtime would be worse than waiting.
    expect(
      await failure(
        stranger.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: l.generation,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(waiting).toHaveLength(1);
    // A host that knows the profile takes it.
    expect((await claim(l)).session_id).toBe(session.session_id);
  });

  test("a session without a repository is claimed by profile alone; a row from before the catalog is not", async () => {
    const coding = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default" as const,
      provider: {
        kind: "litellm" as const,
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key" as const,
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    const general = {
      ...coding,
      tools: ["Read", "Write"],
      repository: "none" as const,
    };
    const host = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testSessionCatalog({
        repositories: {
          "sample-app": {
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
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
    const claimOn = (l: Awaited<ReturnType<typeof launch>>) =>
      host.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });

    const oldPartition = partitionFor("before-catalog");
    const old = await queuedSession(oldPartition);
    await db
      .update(sessions)
      .set({ repositoryId: null })
      .where(eq(sessions.id, old.session_id));
    const pooled = await insertUnreservedLaunch(db, {
      partition: oldPartition,
    });
    expect(await failure(claimOn(pooled))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });

    const partition = partitionFor("without-repository");
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: `owner-${crypto.randomUUID()}` },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      profileFingerprint: profileFingerprint(general),
      model: general.model,
      repository: "none",
      message: "first input",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));

    const claimed = await claimOn(await launch(sessionId));
    expect(claimed.session_id).toBe(sessionId);
    expect(claimed.workspace).toEqual({ repository: null });
    expect(claimed.runtime_config.tools).toEqual(["Read", "Write"]);
    const issued = await db
      .select({ purpose: workerCredentials.purpose })
      .from(workerCredentials)
      .where(eq(workerCredentials.attemptId, claimed.attempt_id));
    expect(issued.map((row) => row.purpose).sort()).toEqual([
      "gateway",
      "object_store",
      "packages",
      "provider",
    ]);
  });

  test("an exit observation racing the last heartbeats never deadlocks", async () => {
    for (let round = 0; round < 5; round += 1) {
      const partition = partitionFor(`race${round}`);
      const queued = await queuedSession(partition);
      const l = await launch(queued.session_id);
      const claimed = await claim(l);
      const beats = [0, 1, 2].map(() =>
        gateway
          .heartbeat(principalOf(claimed), {
            ...scopeOf(claimed),
            attempt_state: "running",
          })
          .catch((error: unknown) => error),
      );
      const settled = await Promise.all([
        confirmExecutionGone(db, l.executionId),
        ...beats,
      ]);
      for (const outcome of settled) {
        // A heartbeat losing to the exit is expected; a lock-order deadlock
        // (SQLSTATE 40P01) is not.
        expect(String((outcome as { code?: string })?.code ?? "")).not.toBe(
          "40P01",
        );
      }
    }
  });

  test("a finalize that committed is still readable once the lease lapsed", async () => {
    const { claimed } = await claimAndDeliver(partitionFor("late"));
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "late-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    const first = await gateway.finalize(principalOf(claimed), request);
    advance(LEASE_TTL_MS + 1);
    // The response was lost and the retry arrives too late to write. It must
    // still learn that the turn is settled: answering LEASE_EXPIRED would
    // turn a committed result into an unknown outcome.
    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(
      first,
    );
    // The same key with a different body is still a conflict.
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          terminal: {
            status: "failed" as const,
            reason: "other story",
            result: null,
            usage: null,
          },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  test("a heartbeat keeps the session credential alive with the lease", async () => {
    const partition = partitionFor("cred");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const uow = createPostgresWorkerUnitOfWork(db);
    const withTokenTtl = (sessionTokenTtlMs: number) =>
      createWorkerGateway({
        work: uow,
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
          models: ["claude-sonnet-5"],
          repositories: {
            "sample-app": {
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
          leaseTtlMs: LEASE_TTL_MS,
          sessionTokenTtlMs,
          now: () => clock,
          sleep: async () => {},
        },
      });
    const claimed = await withTokenTtl(600).bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const token = hashWorkerToken(claimed.session_credential);
    // The heartbeat sets a horizon a whole lease out, so the check below
    // lands past the claim's and well inside its own on a loaded runner.
    await withTokenTtl(LEASE_TTL_MS).heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    await sleep(700);
    // Past the horizon the claim set, but the heartbeat pushed it out: a
    // worker that is alive does not lose its token mid-attempt.
    expect(await uow.resolveCredential(token)).toMatchObject({
      kind: "session",
      attemptId: claimed.attempt_id,
    });
    // Past the heartbeat's horizon too.
    await sleep(LEASE_TTL_MS - 600);
    expect(await uow.resolveCredential(token)).toBeNull();
  });

  test("a worker holding the token that lost a claim race recovers by claiming again", async () => {
    const partition = partitionFor("lostrace");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const first = await claim(l);
    const second = await claim(l);
    // The worker received the responses out of order and kept the first
    // token, which the second claim already revoked.
    expect(
      await failure(
        gateway.nextInput(principalOf(first), { ...scopeOf(first) }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    expect(
      await createPostgresWorkerUnitOfWork(db).resolveCredential(
        hashWorkerToken(first.session_credential),
      ),
    ).toBeNull();
    // Nothing has been done under this attempt yet, so another claim hands
    // back the same binding with a credential that works.
    const third = await claim(l);
    expect(third.attempt_id).toBe(second.attempt_id);
    expect(third.auth_revision).toBe(second.auth_revision + 1);
    const next = await gateway.nextInput(principalOf(third), {
      ...scopeOf(third),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a request that waits out its lease on the row lock is refused", async () => {
    const partition = partitionFor("lockwait");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const brief = briefGateway(150);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM attempts WHERE id = $1 FOR UPDATE", [
        claimed.attempt_id,
      ]);
      // The heartbeat blocks on the row lock until after its lease ends, so
      // the clock it started with must not resurrect it.
      const blocked = failure(
        brief.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      );
      await sleep(400);
      await blocker.query("COMMIT");
      expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    } finally {
      blocker.release();
    }
  });

  test("a heartbeat queued behind a held session row gives up within its lock timeout and renews once the row is free", async () => {
    const partition = partitionFor("sessionlock");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const production = briefGateway(DEFAULT_LEASE_TTL_MS);
    const claimed = await production.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [
        queued.session_id,
      ]);
      const queuedBeat = production
        .heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        })
        .then(
          () => "renewed",
          (error: unknown) => pgCode(error) ?? error,
        );
      // A quarter of the production lease budget: the worker's next beat
      // still goes out while the lease can be renewed.
      const answered = await Promise.race([
        queuedBeat,
        sleep((DEFAULT_LEASE_TTL_MS - WORKER_LEASE_SAFETY_MARGIN_MS) / 4).then(
          () => "still waiting",
        ),
      ]);
      expect(answered).toBe("55P03");
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const beat = await production.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    expect(beat.lease_remaining_ms).toBeGreaterThan(0);
  }, 30_000);

  test("an exit confirmed with an end reason records it on the attempts it ends", async () => {
    const reasons: (string | null | undefined)[] = [];
    for (const endReason of ["worker_lease_lost", undefined]) {
      const queued = await queuedSession(partitionFor("endreason"));
      const l = await launch(queued.session_id);
      const claimed = await claim(l);
      await createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
        executionId: l.executionId,
        now: new Date(),
        ...(endReason === undefined ? {} : { endReason }),
      });
      const [attempt] = await db
        .select({ endReason: attempts.endReason })
        .from(attempts)
        .where(eq(attempts.id, claimed.attempt_id));
      reasons.push(attempt?.endReason);
    }
    expect(reasons).toEqual(["worker_lease_lost", "execution_gone"]);
  });

  test("a claim that waits out its TTL on the launch row still hands out a live lease", async () => {
    const partition = partitionFor("claimwait");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
      [l.executionId],
    );
    const pending = claim(l);
    let floor: number;
    try {
      await sleep(400);
      floor = await dbNowMs();
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    const claimed = await pending;
    // Measured from the request the lease would have lost the 400 ms spent
    // on the lock; it starts once the binding exists.
    expect(new Date(claimed.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      floor + LEASE_TTL_MS,
    );
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a claim that waits out the nonce window on the launch row is refused and binds nothing", async () => {
    const partition = partitionFor("noncewait");
    const session = await queuedSession(partition);
    const l = await launch(session.session_id);
    // The deadline is set on the database clock so that it passes while the
    // claim is blocked on the row, not before it asks for the lock.
    await db
      .update(workerLaunches)
      .set({
        nonceExpiresAt: sql`clock_timestamp() + interval '200 milliseconds'`,
      })
      .where(eq(workerLaunches.executionId, l.executionId));
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM worker_launches WHERE execution_id = $1 FOR UPDATE",
      [l.executionId],
    );
    const pending = failure(claim(l));
    try {
      await sleep(400);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    // Judged once the lock is granted: the window closed while waiting, so
    // the claim is refused however fresh it was when it arrived.
    expect(await pending).toEqual({ status: 401, code: "UNAUTHORIZED" });
    const [row] = await db
      .select({ claimedAttemptId: workerLaunches.claimedAttemptId })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(row?.claimedAttemptId).toBeNull();
    expect(
      await db
        .select({ n: count() })
        .from(attempts)
        .where(eq(attempts.sessionId, session.session_id)),
    ).toEqual([{ n: 0 }]);
  });

  test("a finalize that waits out its lease on the turn row commits nothing", async () => {
    const partition = partitionFor("finwait");
    const session = await queuedSession(partition);
    const claimed = await claim(await launch(session.session_id));
    await gateway.nextInput(principalOf(claimed), { ...scopeOf(claimed) });
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM turns WHERE id = $1 FOR UPDATE", [
      turn?.id,
    ]);
    // The fence holds when it is taken; the lease runs out while finalize
    // waits for the turn row it is about to write.
    await leaseEndsIn(claimed.attempt_id, 400);
    const blocked = failure(
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "waited-1",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      }),
    );
    try {
      await sleep(700);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [after] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(after?.status).toBe("running");
  });

  test("a nextInput that waits out its lease on the queue head delivers nothing", async () => {
    const partition = partitionFor("headwait");
    const session = await queuedSession(partition);
    const l = await launch(session.session_id);
    const brief = briefGateway(400);
    const claimed = await brief.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM queue_messages WHERE session_id = $1 FOR UPDATE",
      [session.session_id],
    );
    // The fence held when it was taken. By the time the head is free the
    // lease is gone, and handing the turn over would start work on a session
    // this attempt no longer owns.
    const blocked = failure(
      brief.nextInput(principalOf(claimed), { ...scopeOf(claimed) }),
    );
    try {
      await sleep(700);
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    expect(await blocked).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [turn] = await db
      .select({ status: turns.status, attemptId: turns.attemptId })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn).toEqual({ status: "queued", attemptId: null });
  });

  test("a claim replayed on a host without the profile rotates nothing", async () => {
    const partition = partitionFor("replayprofile");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const claimed = await claim(l);
    const stranger = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: { profiles: {}, repositories: {} },
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: LEASE_TTL_MS,
        now: () => clock,
        sleep: async () => {},
      },
    });
    expect(
      await failure(
        stranger.bootstrapClaim(bootstrap, {
          execution_id: l.executionId,
          execution_generation: l.generation,
          credential: { kind: "launch_nonce", nonce: l.nonce },
        }),
      ),
    ).toEqual({ status: 503, code: "BACKEND_UNAVAILABLE" });
    // The worker that holds the first token is untouched: same revision,
    // same token, and it can still take its turn.
    const [attempt] = await db
      .select({ authRevision: attempts.authRevision })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.authRevision).toBe(0);
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(claimed.session_credential)),
    ).toMatchObject({ kind: "session", attemptId: claimed.attempt_id });
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a launch reserved for one session claims that session, not the queue head", async () => {
    const partition = partitionFor("pinned");
    const first = await queuedSession(partition, "oldest");
    const second = await queuedSession(partition, "newest");
    // The backend that started this execution gave it the second session's
    // workspace; taking the older head would run one session's input in
    // another one's directory.
    const claimed = await claim(await launch(second.session_id));
    expect(claimed.session_id).toBe(second.session_id);
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.message).toBe("newest");
    // The session it passed over is still waiting for its own launch.
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, first.session_id));
    expect(waiting).toHaveLength(1);
  });

  test("a session that is already bound gets no second launch", async () => {
    const partition = partitionFor("taken");
    const session = await queuedSession(partition);
    const other = await queuedSession(partition);
    await claim(await launch(session.session_id));
    // Another execution for the same session must wait rather than fall
    // through to whatever else happens to be queued.
    await expect(launch(session.session_id)).rejects.toThrow("not launchable");
    const waiting = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, other.session_id));
    expect(waiting).toHaveLength(1);
  });

  test("two finalizes of the same turn in flight agree on one result", async () => {
    const { session, claimed } = await claimAndDeliver(partitionFor("dblfin"));
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "double-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    };
    const [a, b] = await Promise.all([
      gateway.finalize(principalOf(claimed), request),
      gateway.finalize(principalOf(claimed), request),
    ]);
    expect(a).toEqual(b);
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.status).toBe("completed");
    // The input is acknowledged once, not twice.
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.session_id)),
    ).toHaveLength(0);
  });

  test("a claim replayed after the lease lapsed comes back with a fresh one", async () => {
    const partition = partitionFor("lapsed");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const brief = briefGateway(300);
    const request = {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    } as const;
    const first = await brief.bootstrapClaim(bootstrap, request);
    // The first response was lost and the retry arrives after the lease it
    // carried has run out, but before the nonce expires. It lands on a
    // replica with the usual TTL, so the binding has a whole lease to prove
    // it works in.
    await sleep(350);
    const floor = await dbNowMs();
    const second = await gateway.bootstrapClaim(bootstrap, request);
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(new Date(second.lease_expires_at).getTime()).toBeGreaterThanOrEqual(
      floor + LEASE_TTL_MS,
    );
    // The binding it just answered with actually works.
    const next = await gateway.nextInput(principalOf(second), {
      ...scopeOf(second),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("the database clock judges the lease, not the clock of the replica handling the request", async () => {
    const partition = partitionFor("skew");
    const queued = await queuedSession(partition);
    const behind = skewedGateway(-60_000, LEASE_TTL_MS);
    const ahead = skewedGateway(60_000, LEASE_TTL_MS);
    const l = await launch(queued.session_id);
    const claimed = await behind.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
    // Judged by its own clock the replica running a minute ahead would call
    // this lease long gone; the database says it is live.
    const floor = await dbNowMs();
    const beat = await ahead.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
    });
    const ceiling = await dbNowMs();
    const extended = new Date(beat.lease_expires_at).getTime();
    expect(extended).toBeGreaterThanOrEqual(floor + LEASE_TTL_MS);
    expect(extended).toBeLessThanOrEqual(ceiling + LEASE_TTL_MS);

    const lapsed = await leaseEndsIn(claimed.attempt_id, 300);
    await sleep(350);
    // Judged by its own clock the replica running a minute behind would
    // still approve these writes; the database says the lease has ended.
    expect(
      await failure(
        behind.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    expect(
      await failure(
        behind.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed),
          turn_id: null,
          batch_key: "skew-1",
          events: [event(1)],
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
    const [attempt] = await db
      .select({ leaseExpiresAt: attempts.leaseExpiresAt })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.leaseExpiresAt.getTime()).toBe(lapsed);
  });

  test("claim and heartbeat hand the lease out as time left on the database clock, never more than the worker has", async () => {
    // Long enough that a loaded runner does not see it lapse mid-test.
    const TTL = 5_000;
    const partition = partitionFor("remaining");
    const queued = await queuedSession(partition);
    const behind = skewedGateway(-60_000, TTL);
    const ahead = skewedGateway(60_000, TTL);
    const l = await launch(queued.session_id);
    const claim = () =>
      behind.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });
    // A worker counts the remainder from its own send: whatever instant that
    // stands for on the database clock, the sum may not pass the deadline
    // the database will judge, and the replica's clock must not enter it.
    const within = async (
      sentAt: number,
      answer: { lease_expires_at: string; lease_remaining_ms: number },
    ) => {
      const answeredAt = await dbNowMs();
      // A whole TTL, give or take the transaction it was granted in.
      expect(answer.lease_remaining_ms).toBeGreaterThanOrEqual(TTL - 1);
      expect(answer.lease_remaining_ms).toBeLessThanOrEqual(
        TTL + (answeredAt - sentAt),
      );
      expect(sentAt + answer.lease_remaining_ms).toBeLessThanOrEqual(
        new Date(answer.lease_expires_at).getTime(),
      );
    };
    let sentAt = await dbNowMs();
    const claimed = await claim();
    await within(sentAt, claimed);
    // The replay path answers from the same clock read.
    sentAt = await dbNowMs();
    const replayed = await claim();
    await within(sentAt, replayed);
    for (const replica of [ahead, behind]) {
      sentAt = await dbNowMs();
      const beat = await replica.heartbeat(principalOf(replayed), {
        ...scopeOf(replayed),
        attempt_state: "running",
      });
      await within(sentAt, beat);
    }
  });

  test("the database clock judges the launch nonce, not the clock of the replica that claims it", async () => {
    const partition = partitionFor("nonce-skew");
    const behind = skewedGateway(-60_000, 300);
    const ahead = skewedGateway(60_000, 300);
    const launchNew = async () => {
      const queued = await queuedSession(partition);
      const floor = await dbNowMs();
      const l = await launch(queued.session_id);
      const ceiling = await dbNowMs();
      // The stored deadline follows the database clock plus the TTL.
      const [row] = await db
        .select({ nonceExpiresAt: workerLaunches.nonceExpiresAt })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, l.executionId));
      const expiresAt = row?.nonceExpiresAt?.getTime() ?? Number.NaN;
      // The column keeps microseconds; the Date read back is floored to ms.
      expect(expiresAt).toBeGreaterThanOrEqual(
        Math.floor(floor) + DEFAULT_NONCE_TTL_MS,
      );
      expect(expiresAt).toBeLessThanOrEqual(ceiling + DEFAULT_NONCE_TTL_MS);
      return l;
    };
    const claimWith = (from: ReturnType<typeof skewedGateway>, l: TestLaunch) =>
      from.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });

    // Claimed a minute ahead: on that replica's clock the ten-minute window
    // is still open, and so it is in the database.
    const first = await launchNew();
    expect((await claimWith(ahead, first)).attempt_id).toMatch(/^att_/);

    // A deadline that the database has passed is refused even by the replica
    // whose own clock would still call it open.
    const second = await launchNew();
    await db
      .update(workerLaunches)
      .set({ nonceExpiresAt: new Date(Date.now() - 1) })
      .where(eq(workerLaunches.executionId, second.executionId));
    expect(await failure(claimWith(behind, second))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });
  test("any accepted call closes the claim replay window, not just the first input", async () => {
    const partition = partitionFor("used");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const claimed = await claim(l);
    // An event on no turn is the worker's first sign of life. It leaves the
    // attempt with no input and no turn, and it still has to count.
    await gateway.appendEvents(principalOf(claimed), {
      ...scopeOf(claimed),
      turn_id: null,
      batch_key: "b",
      events: [event(1)],
    });
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("starting");
    // Whoever still holds the nonce cannot take the binding from under it.
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    const next = await gateway.nextInput(principalOf(claimed), {
      ...scopeOf(claimed),
    });
    expect(next.input?.turn_id).toBe("1");
  });

  test("a late heartbeat cannot walk the reported phase backwards", async () => {
    const partition = partitionFor("hborder");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const claimed = await claim(l);
    const beat = (attempt_state: "starting" | "running" | "draining") =>
      gateway.heartbeat(principalOf(claimed), {
        ...scopeOf(claimed),
        attempt_state,
      });
    const phase = async () => {
      const [row] = await db
        .select({ state: attempts.state })
        .from(attempts)
        .where(eq(attempts.id, claimed.attempt_id));
      return row?.state;
    };
    await beat("running");
    await beat("starting");
    expect(await phase()).toBe("running");
    await beat("draining");
    expect(await phase()).toBe("draining");
  });

  test("a replayed claim moves the auth revision so an older token's requests are fenced", async () => {
    const partition = partitionFor("authrev");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const first = await claim(l);
    const second = await claim(l);
    expect(second.attempt_id).toBe(first.attempt_id);
    expect(second.auth_revision).toBe(first.auth_revision + 1);
    // A request authenticated before the rotation carries the old revision.
    expect(
      await failure(
        gateway.heartbeat(principalOf(first), {
          ...scopeOf(first),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
    // ...and it cannot address the new revision either: the token it
    // authenticated with was issued for the old one.
    expect(
      await failure(
        gateway.heartbeat(principalOf(first), {
          ...scopeOf(second),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    const beat = await gateway.heartbeat(principalOf(second), {
      ...scopeOf(second),
      attempt_state: "running",
    });
    expect(beat.auth_revision).toBe(second.auth_revision);
  });

  test("writes from a superseded epoch are refused with 409 STALE_EPOCH", async () => {
    const { session, claimed } = await claimAndDeliver();
    // A terminate/reconcile elsewhere bumps the session epoch.
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    for (const call of [
      () =>
        gateway.heartbeat(principalOf(claimed), {
          ...scopeOf(claimed),
          attempt_state: "running",
        }),
      () =>
        gateway.appendEvents(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          batch_key: "b",
          events: [event(1)],
        }),
      () =>
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, "1"),
          turn_id: "1",
          finalize_key: "f",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: null,
        }),
      () => gateway.nextInput(principalOf(claimed), scopeOf(claimed)),
    ]) {
      expect(await failure(call())).toEqual({
        status: 409,
        code: "STALE_EPOCH",
      });
    }
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "stale",
      }),
    ).toEqual({ released: false });
    const [storedRow] = await db
      .select({ stored: count() })
      .from(events)
      .where(workerStream(session.session_id));
    expect(storedRow?.stored).toBe(0);
  });

  test("finalize commits checkpoint, turn terminal, receipt and queue ACK in one transaction and replays by key", async () => {
    const { session, claimed } = await claimAndDeliver();
    // The first checkpoint of a session is revision 0: exactly the next one
    // after "none", as checkpointStateAtomic would have handed out.
    const checkpoint = {
      revision: 0,
      manifest_ref: "s3://bucket/manifest-0.json",
      manifest_sha256: "a".repeat(64),
    };
    const request = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: { text: "done" },
        usage: { input_tokens: 3 },
      },
      checkpoint,
    };
    const done = await gateway.finalize(principalOf(claimed), request);
    expect(done).toEqual({
      turn_id: "1",
      status: "completed",
      checkpoint_revision: 0,
    });

    const [turn] = await db
      .select()
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("completed");
    expect(turn?.endedAt?.toISOString()).toBe(clock.toISOString());
    expect(turn?.resultJson).toMatchObject({
      finalize_key: "fin-1",
      result: { text: "done" },
      usage: { input_tokens: 3 },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("succeeded");
    expect(receipt?.result).toEqual(session);
    const remaining = await db
      .select()
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, session.session_id));
    expect(remaining).toHaveLength(0);
    const [cp] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(cp?.revision).toBe(0);
    expect(cp?.turnId).toBe(turn?.id ?? -1);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("idle");
    expect(row?.checkpointRevision).toBe(0);
    expect(row?.checkpointCommittedAt?.toISOString()).toBe(clock.toISOString());

    expect(await gateway.finalize(principalOf(claimed), request)).toEqual(done);
    // The same bytes stored again are another object version: a retry naming
    // one is a different body, not a replay.
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          checkpoint: { ...checkpoint, manifest_version: "v2" },
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...request,
          finalize_key: "fin-2",
          final_source_sequence: 0,
        }),
      ),
    ).toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    const empty = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    expect(empty.input).toBeNull();
  });

  test("a settled input replays its acceptance response for the same idempotency key", async () => {
    const partition = partitionFor("replay");
    const inputs = createPostgresSessionUnitOfWork(db);
    const ownerId = `owner-${crypto.randomUUID()}`;
    const create = {
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: "claude-coding-v1",
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
    };
    const created = await inputs.acceptInputAtomic(create);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const sessionId = created.response.session_id;
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const claimed = await claim(await launch(sessionId));
    const finalizeTurn = async (
      turnId: string,
      status: "completed" | "failed",
    ) => {
      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(next.input?.turn_id).toBe(turnId);
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status,
          reason: status === "failed" ? "boom" : null,
          result: { text: "done" },
          usage: null,
        },
        checkpoint: null,
      });
    };
    await finalizeTurn("1", "completed");

    const append = {
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId },
      sessionId,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    };
    const appended = await inputs.appendInputAtomic(append);
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    await finalizeTurn("2", "failed");

    expect(await inputs.acceptInputAtomic(create)).toEqual({
      outcome: "replayed",
      response: created.response,
    });
    expect(await inputs.appendInputAtomic(append)).toEqual({
      outcome: "replayed",
      response: appended.response,
    });
    const receiptOf = async (id: string) =>
      (
        await db
          .select({ status: receipts.status, result: receipts.result })
          .from(receipts)
          .where(eq(receipts.id, id))
      )[0];
    // Settled either way, and the current outcome is on the receipt itself.
    expect(await receiptOf(created.response.receipt_id)).toEqual({
      status: "succeeded",
      result: created.response,
    });
    expect(await receiptOf(appended.response.receipt_id)).toEqual({
      status: "failed",
      result: appended.response,
    });
  });

  test("finalize refuses a rejected manifest and a revision that is not the next one without touching the turn", async () => {
    const { session, claimed } = await claimAndDeliver();
    const base = {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed" as const,
        reason: null,
        result: null,
        usage: null,
      },
    };
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...base,
          checkpoint: {
            revision: 0,
            manifest_ref: "bad/ref",
            manifest_sha256: "b".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    await db
      .update(sessions)
      .set({ checkpointRevision: 5 })
      .where(eq(sessions.id, session.session_id));
    // Neither the current revision nor one that skips ahead: only 6 is next.
    // That is a race the worker recovers from by asking again, so it is a
    // revision conflict, not an unavailable checkpoint.
    for (const revision of [5, 7]) {
      expect(
        await failure(
          gateway.finalize(principalOf(claimed), {
            ...base,
            checkpoint: {
              revision,
              manifest_ref: "ok/ref",
              manifest_sha256: "c".repeat(64),
            },
          }),
        ),
      ).toEqual({ status: 409, code: "REVISION_CONFLICT" });
    }
    const [turn] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(turn?.status).toBe("running");
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("accepted");
  });

  test("the workspace descriptor rides every claim, with and without a restore pointer; a pre-catalog row is not claimed", async () => {
    const partition = partitionFor("descriptor");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    expect(claimed.restore).toBeNull();
    const checkpoint = {
      revision: 0,
      manifest_ref: "s3://bucket/descriptor-manifest-0.json",
      manifest_sha256: "b".repeat(64),
    };
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin-desc",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint,
    });
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    await confirmExecutionGone(db, l.executionId);
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: {
        ownerId:
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.id, session.session_id))
          )[0]?.ownerId ?? "",
      },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    await db
      .update(sessions)
      .set({ partition })
      .where(eq(sessions.id, session.session_id));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, session.session_id));
    // A pre-catalog row has no repository id, so no catalog pair can vouch
    // for it: it waits instead of running under a profile's trust
    // that nothing granted it.
    await db
      .update(sessions)
      .set({ repositoryId: null })
      .where(eq(sessions.id, session.session_id));
    await expect(
      claim(await insertUnreservedLaunch(db, { partition })),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    await db
      .update(sessions)
      .set({ repositoryId: "sample-app" })
      .where(eq(sessions.id, session.session_id));
    const again = await claim(await launch(session.session_id));
    expect(again.session_id).toBe(session.session_id);
    expect(again.restore).toEqual(checkpoint);
    expect(again.workspace).toEqual({
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
        access: { kind: "egress_token", token: expect.stringMatching(/^wer_/) },
      },
    });
    expect(again.runtime_config.model).toBe("claude-sonnet-5");
  });

  test("claim binds only a pair the catalog allows, at the URL and branch it registers now", async () => {
    const profile = {
      runtime_kind: "claude_agent_sdk" as const,
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default" as const,
      provider: {
        kind: "litellm" as const,
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key" as const,
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
      project_settings: { claude_md: true },
    };
    const registered = {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: { kind: "github_app", registered: true } as const,
    };
    const gatewayFor = (
      repositories: Record<string, typeof registered>,
    ): WorkerGateway =>
      createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog: testSessionCatalog({
          repositories,
        }),
        checkpoints: {
          async verify() {
            return { status: "verified" };
          },
        },
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: LEASE_TTL_MS,
          now,
          sleep: async () => {},
        },
      });
    const claimOn = (
      target: WorkerGateway,
      l: Awaited<ReturnType<typeof launch>>,
    ) =>
      target.bootstrapClaim(bootstrap, {
        execution_id: l.executionId,
        execution_generation: l.generation,
        credential: { kind: "launch_nonce", nonce: l.nonce },
      });
    const refused: Array<[string, Record<string, typeof registered>]> = [
      [
        "the repository lists another profile",
        { "sample-app": { ...registered, profiles: ["other"] } },
      ],
      [
        "the id now points at another URL",
        {
          "sample-app": {
            ...registered,
            url: "https://example.invalid/other.git",
          },
        },
      ],
      [
        "the id now points at another branch",
        { "sample-app": { ...registered, branch: "release" } },
      ],
      ["the repository left the catalog", { other: registered }],
    ];
    for (const [label, repositories] of refused) {
      const partition = partitionFor("pair");
      const session = await queuedSession(partition);
      const l = await insertUnreservedLaunch(db, { partition });
      await expect(
        claimOn(gatewayFor(repositories), l),
        label,
      ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
      const [row] = await db
        .select({ podId: sessions.podId })
        .from(sessions)
        .where(eq(sessions.id, session.session_id));
      expect(row?.podId, label).toBeNull();
      // The same launch claims once the pair is allowed again.
      const claimed = await claimOn(
        gatewayFor({ "sample-app": registered }),
        l,
      );
      expect(claimed.session_id, label).toBe(session.session_id);
    }

    // A replay (the claim response was lost) on a host whose catalog no
    // longer allows the pair is refused before the token rotates.
    const partition = partitionFor("pair-replay");
    const session = await queuedSession(partition);
    const l = await launch(session.session_id);
    const first = await claimOn(gatewayFor({ "sample-app": registered }), l);
    await expect(
      claimOn(
        gatewayFor({ "sample-app": { ...registered, profiles: ["other"] } }),
        l,
      ),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    const [row] = await db
      .select({ authRevision: sessions.authRevision })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.authRevision).toBe(first.auth_revision);
  });

  test("a failed terminal marks the receipt failed and the session failed", async () => {
    const { session, claimed } = await claimAndDeliver();
    const done = await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "failed",
        reason: "sdk_error",
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    expect(done.checkpoint_revision).toBeNull();
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("failed");
    expect(receipt?.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "sdk_error",
    });
    const [row] = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row?.status).toBe("failed");
  });

  test("release ends the attempt but the session stays unclaimable until the execution is confirmed gone", async () => {
    const partition = partitionFor("rel");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      // Covered, so the next claim restores it rather than meeting the
      // context gate.
      checkpoint: {
        revision: 0,
        manifest_ref: "s3://bucket/release-0.json",
        manifest_sha256: "a".repeat(64),
      },
    });
    // A second input arrives while the worker is still bound.
    await createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: {
        ownerId:
          (
            await db
              .select()
              .from(sessions)
              .where(eq(sessions.id, session.session_id))
          )[0]?.ownerId ?? "",
      },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "second input",
    });
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "idle_timeout",
      }),
    ).toEqual({ released: true });
    expect(
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "idle_timeout",
      }),
    ).toEqual({ released: false });
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("exited");
    expect(attempt?.endReason).toBe("idle_timeout");
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.resolveCredential(hashWorkerToken(claimed.session_credential)),
    ).toBeNull();

    // No new launch while the execution may still be alive.
    await expect(launch(session.session_id)).rejects.toThrow("not launchable");
    const [bound] = await db
      .select({ podId: sessions.podId, leaseEpoch: sessions.leaseEpoch })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(bound?.podId).toBe(l.executionId);
    expect(bound?.leaseEpoch).toBe(claimed.lease_epoch + 1);

    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const reclaimed = await claim(await launch(session.session_id));
    expect(reclaimed.session_id).toBe(session.session_id);
    expect(reclaimed.lease_epoch).toBe(claimed.lease_epoch + 3);
    expect(reclaimed.restore?.revision).toBe(0);
    const redelivered = await gateway.nextInput(
      principalOf(reclaimed),
      scopeOf(reclaimed),
    );
    expect(redelivered.input?.turn_id).toBe("2");
    expect(redelivered.input?.message).toBe("second input");
  });

  test("an execution that ends mid-turn leaves an unknown outcome, not work in progress", async () => {
    const partition = partitionFor("unk");
    const { session, launch: l } = await claimAndDeliver(partition);
    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    // Nothing re-signals the session: the delivered input must not run again.
    const signals = await db
      .select()
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signals).toHaveLength(0);
    const [row] = await db
      .select({
        podId: sessions.podId,
        status: sessions.status,
        admissionState: sessions.admissionState,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row).toEqual({
      podId: null,
      status: "failed",
      admissionState: "recovery_required",
    });
    const [turn] = await db
      .select({
        status: turns.status,
        outcomeUnknown: turns.outcomeUnknown,
        terminalReason: turns.terminalReason,
      })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn).toEqual({
      status: "outcome_unknown",
      outcomeUnknown: true,
      terminalReason: "execution_gone",
    });
    const [receipt] = await db
      .select({ status: receipts.status })
      .from(receipts)
      .where(eq(receipts.id, session.receipt_id));
    expect(receipt?.status).toBe("unknown");
    // The input stays on the queue for the operator decision.
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, session.session_id)),
    ).toHaveLength(1);
  });

  test("a heartbeat cannot walk the attempt back to allocated or end it", async () => {
    const partition = partitionFor("hbstate");
    const queued = await queuedSession(partition);
    const l = await launch(queued.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    for (const state of ["allocated", "exited", "lost"] as const) {
      expect(
        await failure(
          gateway.heartbeat(principalOf(claimed), {
            ...scopeOf(claimed),
            attempt_state: state,
          }),
        ),
      ).toEqual({ status: 400, code: "BAD_REQUEST" });
    }
    const [attempt] = await db
      .select({ state: attempts.state })
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.state).toBe("running");
    // The claim-replay door stays shut, which a regression would reopen.
    expect(await failure(claim(l))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  test("launch slots: bootstrapClaim inherits the reservation and each exit returns it exactly once", async () => {
    const partition = partitionFor("slots");
    const reserved = async () => {
      const [row] = await db
        .select({ reserved: count() })
        .from(workerLaunches)
        .where(
          and(
            eq(workerLaunches.partition, partition),
            isNull(workerLaunches.slotReleasedAt),
          ),
        );
      return row?.reserved;
    };
    const launches = [];
    for (let i = 0; i < 30; i += 1) {
      const queued = await queuedSession(partition);
      launches.push(await launch(queued.session_id));
    }
    expect(await reserved()).toBe(30);
    for (const l of launches) {
      const claimed = await claim(l);
      await claim(l);
      await gateway.release(principalOf(claimed), {
        ...scopeOf(claimed),
        reason: "done",
      });
    }
    expect(await reserved()).toBe(30);
    for (const l of launches) {
      expect((await confirmExecutionGone(db, l.executionId)).slotReleased).toBe(
        true,
      );
      expect((await confirmExecutionGone(db, l.executionId)).slotReleased).toBe(
        false,
      );
    }
    expect(await reserved()).toBe(0);
  });

  // every worker with a mirror beats this way until its first batch
  // lands, and the empty update it used to run failed the beat with a 500.
  test("a transcript report with nothing mirrored yet extends the lease and records nothing", async () => {
    const partition = partitionFor("mirrorempty");
    const { session, claimed } = await claimAndDeliver(partition);
    const read = async () =>
      (
        await db
          .select({
            lease: attempts.leaseExpiresAt,
            pending: sessions.checkpointPendingReason,
            persistedAt: sessions.lastTranscriptPersistedAt,
          })
          .from(sessions)
          .innerJoin(attempts, eq(attempts.id, claimed.attempt_id))
          .where(eq(sessions.id, session.session_id))
      )[0];
    const before = await read();
    await Bun.sleep(5);
    const beat = await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: null },
    });
    const after = await read();
    expect(new Date(beat.lease_expires_at).getTime()).toBeGreaterThan(
      before?.lease.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(after).toEqual({
      lease: new Date(beat.lease_expires_at),
      pending: null,
      persistedAt: null,
    });
  });

  test("a mirror failure holds new input and completed terminals, and a checkpoint from the same attempt does not release it", async () => {
    const partition = partitionFor("mirror");
    const { session, launch: l, claimed } = await claimAndDeliver(partition);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    const append = (message: string) =>
      createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
    const row = async () => {
      const [stored] = await db
        .select({
          pending: sessions.checkpointPendingReason,
          pendingAttempt: sessions.checkpointPendingAttemptId,
          persistedAt: sessions.lastTranscriptPersistedAt,
          revision: sessions.checkpointRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, session.session_id));
      return stored;
    };
    // Queued before the failure: what the next attempt will run.
    expect((await append("second input")).outcome).toBe("accepted");

    const later = new Date("2026-09-22T00:00:10.000Z");
    const earlier = new Date("2026-09-22T00:00:05.000Z");
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: {
        persisted_at: later.toISOString(),
        mirror_error: "batch 7 dropped",
      },
    });
    expect(await row()).toMatchObject({
      pending: "mirror_error",
      pendingAttempt: claimed.attempt_id,
      persistedAt: later,
    });
    // A late heartbeat neither walks the mark back nor clears the reason.
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: earlier.toISOString(), mirror_error: null },
    });
    expect(await row()).toMatchObject({
      pending: "mirror_error",
      persistedAt: later,
    });
    // Neither does asking for a checkpoint at a safe boundary.
    expect(
      await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({
      outcome: "ok",
      pointer: null,
      restorable: false,
      pendingReason: "mirror_error",
    });

    // New input is refused: a turn run now could never be reported done.
    expect(await append("third input")).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "mirror_error",
    });
    // So is a success the worker cannot back with a checkpoint...
    const terminal = (status: "completed" | "interrupted") => ({
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: `fin-${status}`,
      final_source_sequence: 0,
      terminal: { status, reason: null, result: null, usage: null },
    });
    expect(
      await failure(
        gateway.finalize(principalOf(claimed), {
          ...terminal("completed"),
          checkpoint: null,
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    const [open] = await db
      .select({ status: turns.status })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
      );
    expect(open?.status).toBe("running");
    // ...while a checkpoint from the same attempt closes the turn but proves
    // nothing about the transcript since the failure: the reason stays.
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...terminal("completed"),
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/mirror-0.json",
          manifest_sha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({ status: "completed", checkpoint_revision: 0 });
    expect(await row()).toMatchObject({ pending: "mirror_error", revision: 0 });

    // The pointer the failing run committed is not trusted, so no worker
    // can take the session on from it: once the execution is gone the
    // session waits on an operator instead of being restored from a
    // transcript that may be missing entries.
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "mirror_error",
    });
    await confirmExecutionGone(db, l.executionId);
    const [held] = await db
      .select({
        admission: sessions.admissionState,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(held).toEqual({ admission: "recovery_required", status: "failed" });
    expect(
      (
        await db
          .select({ id: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.session_id))
      ).length,
    ).toBe(0);
    expect(await row()).toMatchObject({ pending: "mirror_error", revision: 0 });
  });

  test("finalize records the verified checkpoint's output objects beside its row, its out/ digest on it, and queues a judgment", async () => {
    const partition = partitionFor("checkpoint-outputs");
    const workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `outputs-${workspaceId.slice(0, 8)}`,
      name: "outputs",
    });
    const { session, claimed, input } = await claimAndDeliver(
      partition,
      workspaceId,
    );
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, session.session_id));
    const ref = `outputs/${session.session_id}/manifest.json`;
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, input.turn_id),
        turn_id: input.turn_id,
        finalize_key: `fin-${input.turn_id}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 0,
          manifest_ref: ref,
          manifest_sha256: "a".repeat(64),
        },
      }),
    ).toMatchObject({ status: "completed", checkpoint_revision: 0 });
    const [row] = await db
      .select({
        recorded: checkpoints.outputsRecorded,
        digest: checkpoints.outputsDigest,
      })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(row).toEqual({ recorded: true, digest: "d".repeat(64) });
    expect(
      await db
        .select({ status: achievementJudgments.status })
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, session.session_id)),
    ).toEqual([{ status: "queued" }]);
    expect(
      await db
        .select({
          revision: checkpointOutputs.revision,
          key: checkpointOutputs.objectKey,
          bytes: checkpointOutputs.bytes,
        })
        .from(checkpointOutputs)
        .where(eq(checkpointOutputs.sessionId, session.session_id))
        .orderBy(checkpointOutputs.bytes),
    ).toEqual([
      { revision: 0, key: `${ref}/a`, bytes: 7 },
      { revision: 0, key: "outputs/inherited", bytes: 11 },
    ]);
  });

  test("a turn's end queues a turns judgment when every_n_turns divides it, and the run's end an idle one", async () => {
    const partition = partitionFor("judgment-triggers");
    const workspaceId = crypto.randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `triggers-${workspaceId.slice(0, 8)}`,
      name: "triggers",
      // every_n_turns below the API's minimum, so the first turn is due.
      settings: {
        achievement_judge: {
          on_evidence: false,
          every_n_turns: 1,
          on_idle: true,
        },
      },
    });
    const typeId = crypto.randomUUID();
    await db.insert(achievementTypes).values({
      id: typeId,
      workspaceId,
      key: "talk",
      name: "Talk",
      evidenceKind: "conversation",
      // No creator to point at: the gate reads the evidence kind only.
      builtin: true,
    });
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    const categoryId = crypto.randomUUID();
    await db.insert(achievementCategories).values({
      id: categoryId,
      workspaceId,
      name: "Talk",
      position: 0,
      createdBy: userId,
    });
    const ruleId = crypto.randomUUID();
    await db.insert(achievementRules).values({
      id: ruleId,
      workspaceId,
      familyId: ruleId,
      version: 1,
      categoryId,
      title: "Talk",
      typeId,
      definition: "A useful talk.",
      judge: "luna",
      createdBy: userId,
    });
    const {
      session,
      launch: l,
      claimed,
      input,
    } = await claimAndDeliver(partition, workspaceId);
    await db
      .update(sessions)
      .set({ workspaceId })
      .where(eq(sessions.id, session.session_id));
    const judged = () =>
      db
        .select({
          trigger: achievementJudgments.trigger,
          status: achievementJudgments.status,
        })
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, session.session_id));
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, input.turn_id),
      turn_id: input.turn_id,
      finalize_key: `fin-${input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    expect(await judged()).toEqual([{ trigger: "turns", status: "queued" }]);

    // The idle run's end merges into the judgment already pending.
    await db
      .update(achievementJudgments)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(eq(achievementJudgments.sessionId, session.session_id));
    await gateway.release(principalOf(claimed), {
      ...scopeOf(claimed),
      reason: "idle_timeout",
    });
    await confirmExecutionGone(db, l.executionId);
    expect(await judged()).toEqual([
      { trigger: "turns", status: "skipped" },
      { trigger: "idle", status: "queued" },
    ]);
  });

  test("finalize records the verified runtime on the pointer row, and a row without one reads as null", async () => {
    const finalizeWith = async (manifestRef: string) => {
      const { session, claimed, input } = await claimAndDeliver(
        partitionFor(`checkpoint-runtime-${manifestRef.split("/")[0]}`),
      );
      expect(
        await gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, input.turn_id),
          turn_id: input.turn_id,
          finalize_key: `fin-${input.turn_id}`,
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 0,
            manifest_ref: `${manifestRef}/${session.session_id}/manifest.json`,
            manifest_sha256: "a".repeat(64),
          },
        }),
      ).toMatchObject({ status: "completed", checkpoint_revision: 0 });
      return session.session_id;
    };
    const rowOf = async (sessionId: string) =>
      (
        await db
          .select({
            engine: checkpoints.runtimeEngine,
            sdkVersion: checkpoints.runtimeSdkVersion,
            cliVersion: checkpoints.runtimeCliVersion,
            profileSha256: checkpoints.runtimeProfileSha256,
          })
          .from(checkpoints)
          .where(eq(checkpoints.sessionId, sessionId))
      )[0];

    const recorded = await finalizeWith("runtime");
    expect(await rowOf(recorded)).toEqual(VERIFIED_RUNTIME);
    expect(await readPointerRuntime(db, recorded)).toEqual(VERIFIED_RUNTIME);

    // What a row committed before the columns holds: all four null.
    const unrecorded = await finalizeWith("plain");
    expect(await rowOf(unrecorded)).toEqual({
      engine: null,
      sdkVersion: null,
      cliVersion: null,
      profileSha256: null,
    });
    expect(await readPointerRuntime(db, unrecorded)).toBeNull();

    const { session: pointerless } = await claimAndDeliver(
      partitionFor("checkpoint-runtime-none"),
    );
    expect(await readPointerRuntime(db, pointerless.session_id)).toBeNull();
  });

  const PREVIOUS_IMAGE_RUNTIME = {
    engine: VERIFIED_RUNTIME.engine,
    sdkVersion: "0.3.260",
    cliVersion: "2.1.260",
    // Not the first scheme, so a checkpoint that took the default would show.
    profileDigestScheme: 2,
  };

  function claimAs(
    l: Awaited<ReturnType<typeof launch>>,
    runtime: typeof PREVIOUS_IMAGE_RUNTIME,
  ) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
      image_runtime: {
        engine: runtime.engine,
        sdk_version: runtime.sdkVersion,
        cli_version: runtime.cliVersion,
        profile_digest_scheme: runtime.profileDigestScheme,
      },
    });
  }

  test("a worker that is not the combination its launch assumed is refused before anything binds, and its image with it", async () => {
    const session = await queuedSession(partitionFor("image-mismatch"));
    const l = await launchSession(db, {
      sessionId: session.session_id,
      image: "sha256:worker-previous",
      imageRuntime: PREVIOUS_IMAGE_RUNTIME,
    });
    const [reserved] = await db
      .select({
        engine: workerLaunches.runtimeEngine,
        sdkVersion: workerLaunches.runtimeSdkVersion,
        cliVersion: workerLaunches.runtimeCliVersion,
        profileDigestScheme: workerLaunches.runtimeProfileScheme,
      })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(reserved).toEqual(PREVIOUS_IMAGE_RUNTIME);

    let refused: unknown;
    try {
      await claimAs(l, { ...PREVIOUS_IMAGE_RUNTIME, sdkVersion: "0.3.270" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorkerGatewayError);
    expect(refused).toMatchObject({
      status: 409,
      code: "LAUNCH_FAILED",
      retryable: false,
      reasonCode: "worker_image_mismatch",
    });

    const refusals = await db
      .select()
      .from(workerImageRefusals)
      .where(eq(workerImageRefusals.executionId, l.executionId));
    expect(refusals).toEqual([
      expect.objectContaining({
        image: "sha256:worker-previous",
        assumedEngine: PREVIOUS_IMAGE_RUNTIME.engine,
        assumedSdkVersion: "0.3.260",
        assumedCliVersion: "2.1.260",
        assumedProfileScheme: 2,
        claimed: { ...PREVIOUS_IMAGE_RUNTIME, sdkVersion: "0.3.270" },
      }),
    ]);
    const [launchRow] = await db
      .select()
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, l.executionId));
    expect(launchRow?.nonceHash).toBeNull();
    expect(launchRow?.claimedAttemptId).toBeNull();
    expect(launchRow?.lastLaunchError).toContain("sha256:worker-previous");
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desiredState).toBe("terminated");
    // The session is not the image's fault: it still waits for a launch.
    const [row] = await db
      .select({
        admissionState: sessions.admissionState,
        podId: sessions.podId,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(row).toEqual({
      admissionState: "active",
      podId: null,
      status: "queued",
    });
    const [waiting] = await db
      .select({ value: count() })
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(waiting?.value).toBe(1);
    // The nonce is spent: the same worker cannot try again.
    expect(await failure(claimAs(l, PREVIOUS_IMAGE_RUNTIME))).toMatchObject({
      status: 401,
    });
  });

  test("a launch on the previous image is told that image's SDK, and its checkpoint keeps the launch's digest scheme", async () => {
    const session = await queuedSession(partitionFor("image-previous"));
    const l = await launchSession(db, {
      sessionId: session.session_id,
      image: "sha256:worker-previous",
      imageRuntime: PREVIOUS_IMAGE_RUNTIME,
    });
    expect((await claimAs(l, PREVIOUS_IMAGE_RUNTIME)).runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.260",
      profile_id: "claude-coding-v1",
    });
    // A worker too old to say what it is still gets the launch's SDK.
    const claimed = await claim(l);
    expect(claimed.runtime.version).toBe("0.3.260");

    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    if (!next.input) throw new Error("no input delivered");
    await finalizeOn(claimed, next.input.turn_id, 0, "runtime");
    const [checkpoint] = await db
      .select({ scheme: checkpoints.runtimeProfileScheme })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(checkpoint?.scheme).toBe(2);
    expect(
      await createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      }).pointerRuntimeOf(session.session_id),
    ).toEqual({
      pointer: recordedPointer(VERIFIED_RUNTIME, 2),
      checkpointRevision: 0,
    });

    // A launch the scheduler reserved without a combination leaves the
    // scheme unrecorded, which reads as the first one.
    const {
      session: legacy,
      claimed: legacyClaim,
      input,
    } = await claimAndDeliver(partitionFor("image-legacy"));
    await finalizeOn(legacyClaim, input.turn_id, 0, "runtime");
    const [unrecorded] = await db
      .select({ scheme: checkpoints.runtimeProfileScheme })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, legacy.session_id));
    expect(unrecorded?.scheme).toBeNull();
  });

  async function sessionPin(sessionId: string) {
    const [row] = await db
      .select({
        image: sessions.firstWorkerImage,
        engine: sessions.runtimeEngine,
        sdkVersion: sessions.runtimeSdkVersion,
        cliVersion: sessions.runtimeCliVersion,
        profileSha256: sessions.runtimeProfileSha256,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!row) throw new Error("no session");
    const { image, ...runtime } = row;
    return { image, runtime };
  }

  function finalizeOn(
    claimed: Awaited<ReturnType<typeof claim>>,
    turnId: string,
    revision: number,
    manifestPrefix: string,
  ) {
    return gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, turnId),
      turn_id: turnId,
      finalize_key: `fin-${turnId}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision,
        manifest_ref: `${manifestPrefix}/${claimed.session_id}/${revision}/manifest.json`,
        manifest_sha256: "a".repeat(64),
      },
    });
  }

  test("the first committed checkpoint carrying a runtime writes it to the session, and no later one overwrites it", async () => {
    const { session, claimed, input } = await claimAndDeliver(
      partitionFor("session-runtime-once"),
    );
    const sessionId = session.session_id;
    const [owner] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const nextTurn = async (message: string) => {
      await createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId: owner?.ownerId ?? "" },
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      if (!next.input) throw new Error("no input delivered");
      return next.input.turn_id;
    };
    const unset = {
      engine: null,
      sdkVersion: null,
      cliVersion: null,
      profileSha256: null,
    };

    // A checkpoint whose manifest carried no runtime records none.
    expect(await finalizeOn(claimed, input.turn_id, 0, "plain")).toMatchObject({
      checkpoint_revision: 0,
    });
    expect((await sessionPin(sessionId)).runtime).toEqual(unset);

    expect(
      await finalizeOn(claimed, await nextTurn("second"), 1, "runtime"),
    ).toMatchObject({ checkpoint_revision: 1 });
    expect(await sessionPin(sessionId)).toEqual({
      image: "sha256:worker",
      runtime: VERIFIED_RUNTIME,
    });

    expect(
      await finalizeOn(claimed, await nextTurn("third"), 2, "runtime-next"),
    ).toMatchObject({ checkpoint_revision: 2 });
    expect(await readPointerRuntime(db, sessionId)).toEqual(NEXT_RUNTIME);
    expect((await sessionPin(sessionId)).runtime).toEqual(VERIFIED_RUNTIME);
  });

  test("a launch that ends before any checkpoint leaves the session's runtime to the launch that first commits one", async () => {
    const session = await queuedSession(partitionFor("session-runtime-f4"));
    const sessionId = session.session_id;
    const first = await launchSession(db, {
      sessionId,
      image: "sha256:worker-a",
    });
    // Gone before it bound a worker, so its signal still stands.
    await confirmExecutionGone(db, first.executionId);
    expect(await sessionPin(sessionId)).toMatchObject({
      image: "sha256:worker-a",
      runtime: { engine: null },
    });

    const second = await launchSession(db, {
      sessionId,
      image: "sha256:worker-b",
    });
    const secondClaim = await claim(second);
    const next = await gateway.nextInput(
      principalOf(secondClaim),
      scopeOf(secondClaim),
    );
    if (!next.input) throw new Error("no input delivered");
    expect(
      await finalizeOn(secondClaim, next.input.turn_id, 0, "runtime-next"),
    ).toMatchObject({ checkpoint_revision: 0 });

    // The image stays the first reservation's; the runtime is the one the
    // committing launch's manifest names.
    expect(await sessionPin(sessionId)).toEqual({
      image: "sha256:worker-a",
      runtime: NEXT_RUNTIME,
    });
    expect(await readPointerRuntime(db, sessionId)).toEqual(NEXT_RUNTIME);
  });

  test("a transcript past the limit keeps the turn that crossed it and the last checkpoint, and takes no new turn", async () => {
    const partition = partitionFor("transcript-limit");
    const { session, claimed, input } = await claimAndDeliver(partition);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    const append = (message: string) =>
      createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId },
        sessionId: session.session_id,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
      });
    const detail = () =>
      createPostgresSessionReader(db).getSession(ownerId, session.session_id);
    const systemEvents = async (subtype: string) =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(
            and(
              eq(events.sessionId, session.session_id),
              eq(events.type, "system"),
              sql`${events.payload}->>'subtype' = ${subtype}`,
            ),
          )
      ).map((row) => row.payload);
    const finalize = (
      turnId: string,
      checkpoint: { revision: number; manifest_ref: string } | null,
    ) =>
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint:
          checkpoint === null
            ? null
            : { ...checkpoint, manifest_sha256: "a".repeat(64) },
      });
    const next = async () =>
      (await gateway.nextInput(principalOf(claimed), scopeOf(claimed))).input;
    const warn = transcriptWarnBytes();

    // One byte under the warning threshold: nothing to say.
    await finalize(input.turn_id, {
      revision: 0,
      manifest_ref: `s3://bucket/bytes-${warn - 1}/manifest.json`,
    });
    expect((await detail())?.attention).toBeNull();
    expect(await systemEvents("transcript_near_limit")).toEqual([]);

    // At the threshold: warned once, and the detail says so.
    expect((await append("second")).outcome).toBe("accepted");
    const second = await next();
    if (second === null) throw new Error("second turn not delivered");
    await finalize(second.turn_id, {
      revision: 1,
      manifest_ref: `s3://bucket/bytes-${warn}/manifest.json`,
    });
    expect((await detail())?.attention).toEqual({
      code: "TRANSCRIPT_LIMIT",
      reason: "transcript_near_limit",
      transcript_bytes: warn,
      limit_bytes: expect.any(Number),
    });
    expect(await systemEvents("transcript_near_limit")).toEqual([
      expect.objectContaining({
        transcript_bytes: warn,
        warn_bytes: warn,
        checkpoint_revision: 1,
      }),
    ]);

    // Past the limit: finalize refuses the checkpoint and records why.
    expect((await append("third")).outcome).toBe("accepted");
    expect((await append("queued before the limit")).outcome).toBe("accepted");
    const third = await next();
    if (third === null) throw new Error("third turn not delivered");
    expect(
      await failure(
        finalize(third.turn_id, {
          revision: 2,
          manifest_ref: "over-limit/manifest.json",
        }),
      ),
    ).toEqual({ status: 409, code: "CHECKPOINT_UNAVAILABLE" });
    // The turn that crossed it ran, and is recorded completed without one.
    expect(await finalize(third.turn_id, null)).toMatchObject({
      status: "completed",
      checkpoint_revision: null,
    });
    // A later report of the same reason announces nothing new.
    await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
      fence: fenceOf(claimed),
      now: clock,
      pendingReason: "transcript_too_large",
    });
    expect(await systemEvents("transcript_limit_reached")).toEqual([
      expect.objectContaining({ reason: "transcript_too_large" }),
    ]);

    // No new turn: refused at the door, and the one queued before is held.
    expect(await append("fourth")).toEqual({
      outcome: "checkpoint_unavailable",
      reason: "transcript_too_large",
    });
    expect(await next()).toBeNull();

    // The last checkpoint is still the one to resume from.
    const shown = await detail();
    expect(shown?.attention).toEqual({
      code: "TRANSCRIPT_LIMIT",
      reason: "transcript_too_large",
      transcript_bytes: warn,
      limit_bytes: expect.any(Number),
    });
    expect(shown?.durability).toMatchObject({
      checkpoint_pending_reason: "transcript_too_large",
      checkpoint_revision: 1,
      last_completed_turn_id: third.turn_id,
      last_checkpointed_turn_id: second.turn_id,
    });
    expect(
      await createPostgresWorkerUnitOfWork(db).checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toMatchObject({
      outcome: "ok",
      restorable: true,
      pendingReason: "transcript_too_large",
    });
  });

  test("a mirror failure recorded over a transcript limit still holds queued turns back", async () => {
    const partition = partitionFor("transcript-limit-mirror");
    const { session, claimed, input } = await claimAndDeliver(partition);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    expect(
      (
        await createPostgresSessionUnitOfWork(db).appendInputAtomic({
          limits: {
            queuedInputLimitPerSession: 1_000,
            storageLimitBytes: 1e15,
          },
          principal: { ownerId },
          sessionId: session.session_id,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          message: "queued",
        })
      ).outcome,
    ).toBe("accepted");
    const work = createPostgresWorkerUnitOfWork(db);
    await work.checkpointStateAtomic({
      fence: fenceOf(claimed),
      now: clock,
      pendingReason: "transcript_too_large",
    });
    await work.checkpointStateAtomic({
      fence: fenceOf(claimed),
      now: clock,
      pendingReason: "mirror_error",
    });
    // The running turn ends; the one queued behind it stays queued.
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, input.turn_id),
      turn_id: input.turn_id,
      finalize_key: "fin-failed",
      final_source_sequence: 0,
      terminal: { status: "failed", reason: null, result: null, usage: null },
      checkpoint: null,
    });
    expect(
      (await gateway.nextInput(principalOf(claimed), scopeOf(claimed))).input,
    ).toBeNull();
  });

  test("a pointer start_fresh retired neither warns the session nor hides the next warning", async () => {
    const partition = partitionFor("transcript-limit-reset");
    const { session, claimed, input } = await claimAndDeliver(partition);
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, session.session_id))
      )[0]?.ownerId ?? "";
    const warn = transcriptWarnBytes();
    const finalize = (turnId: string, revision: number) =>
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision,
          manifest_ref: `s3://bucket/bytes-${warn}/manifest-${revision}.json`,
          manifest_sha256: "a".repeat(64),
        },
      });
    const warnings = async () =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(
            and(
              eq(events.sessionId, session.session_id),
              sql`${events.payload}->>'subtype' = 'transcript_near_limit'`,
            ),
          )
      ).length;
    const attention = async () =>
      (
        await createPostgresSessionReader(db).getSession(
          ownerId,
          session.session_id,
        )
      )?.attention;

    await finalize(input.turn_id, 0);
    expect(await warnings()).toBe(1);
    expect(await attention()).toMatchObject({
      reason: "transcript_near_limit",
    });

    // What a start_fresh decision leaves: the pointer stays, retired.
    await db
      .update(sessions)
      .set({ contextResetCheckpointRevision: 0 })
      .where(eq(sessions.id, session.session_id));
    expect(await attention()).toBeNull();

    // The new engine session's first checkpoint at the threshold warns again.
    expect(
      (
        await createPostgresSessionUnitOfWork(db).appendInputAtomic({
          limits: {
            queuedInputLimitPerSession: 1_000,
            storageLimitBytes: 1e15,
          },
          principal: { ownerId },
          sessionId: session.session_id,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          message: "after the reset",
        })
      ).outcome,
    ).toBe("accepted");
    const next = (
      await gateway.nextInput(principalOf(claimed), scopeOf(claimed))
    ).input;
    if (next === null) throw new Error("turn not delivered");
    await finalize(next.turn_id, 1);
    expect(await warnings()).toBe(2);
    expect(await attention()).toMatchObject({
      reason: "transcript_near_limit",
    });
  });

  test("a fallback to a smaller checkpoint does not warn the session a second time", async () => {
    const partition = partitionFor("transcript-limit-fallback");
    const { session, claimed, input } = await claimAndDeliver(partition);
    const sessionId = session.session_id;
    const ownerId =
      (
        await db
          .select({ ownerId: sessions.ownerId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.ownerId ?? "";
    const warn = transcriptWarnBytes();
    const finalize = (turnId: string, revision: number, bytes: number) =>
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, turnId),
        turn_id: turnId,
        finalize_key: `fin-${turnId}`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision,
          manifest_ref: `s3://bucket/bytes-${bytes}/manifest-${revision}.json`,
          manifest_sha256: "a".repeat(64),
        },
      });
    const deliver = async () => {
      await createPostgresSessionUnitOfWork(db).appendInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId },
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message: "next",
      });
      const next = (
        await gateway.nextInput(principalOf(claimed), scopeOf(claimed))
      ).input;
      if (next === null) throw new Error("turn not delivered");
      return next.turn_id;
    };
    const warnings = async () =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(
            and(
              eq(events.sessionId, sessionId),
              sql`${events.payload}->>'subtype' = 'transcript_near_limit'`,
            ),
          )
      ).length;

    expect(
      await commitCheckpoint(db, {
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/small-0.json",
          manifest_sha256: "a".repeat(64),
        },
        fence: fenceOf(claimed),
        now: clock,
        sessionId,
        turnId: null,
        transcriptBytes: warn - 10,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    await finalize(input.turn_id, 1, warn);
    expect(await warnings()).toBe(1);

    // Revision 1 is lost; the restore resumes revision 0 and grows again.
    expect(
      await createPostgresWorkerUnitOfWork(db).recordRestoreBaseAtomic({
        fence: fenceOf(claimed),
        now: clock,
        pointerRevision: 1,
        fallback: {
          revision: 0,
          skipped: [{ revision: 1, reason: "manifest object is missing" }],
        },
      }),
    ).toEqual({ outcome: "ok" });
    await finalize(await deliver(), 2, warn - 5);
    await finalize(await deliver(), 3, warn);
    expect(await warnings()).toBe(1);
  });

  test("a mirror failure never holds back an interrupt that commits its checkpoint", async () => {
    const { session, claimed } = await claimAndDeliver();
    await gateway.heartbeat(principalOf(claimed), {
      ...scopeOf(claimed),
      attempt_state: "running",
      transcript: { persisted_at: null, mirror_error: "batch 2 dropped" },
    });
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "fin-int",
        final_source_sequence: 0,
        terminal: {
          status: "interrupted",
          reason: "user",
          result: null,
          usage: null,
        },
        // an interrupt is only ever recorded with its checkpoint.
        checkpoint: {
          revision: 0,
          manifest_ref: "manifests/interrupted.json",
          manifest_sha256: "d".repeat(64),
        },
      }),
    ).toMatchObject({ status: "interrupted", checkpoint_revision: 0 });
    const [stored] = await db
      .select({
        status: sessions.status,
        pending: sessions.checkpointPendingReason,
      })
      .from(sessions)
      .where(eq(sessions.id, session.session_id));
    expect(stored).toEqual({ status: "stopped", pending: "mirror_error" });
  });

  test.each([
    "background_writer",
    // a ready run whose checkpoint could not be written.
    "publish_failed",
  ] as const)(
    "%s is recorded for display, holds nothing back, and yields to a mirror failure",
    async (reason) => {
      const partition = partitionFor(`quiesce-${reason}`);
      const { session, claimed } = await claimAndDeliver(partition);
      const work = createPostgresWorkerUnitOfWork(db);
      const ownerId =
        (
          await db
            .select({ ownerId: sessions.ownerId })
            .from(sessions)
            .where(eq(sessions.id, session.session_id))
        )[0]?.ownerId ?? "";
      const append = (message: string) =>
        createPostgresSessionUnitOfWork(db).appendInputAtomic({
          limits: {
            queuedInputLimitPerSession: 1_000,
            storageLimitBytes: 1e15,
          },
          principal: { ownerId },
          sessionId: session.session_id,
          idempotencyKey: crypto.randomUUID(),
          payloadHash: crypto.randomUUID(),
          message,
        });
      const pending = async () =>
        (
          await db
            .select({ reason: sessions.checkpointPendingReason })
            .from(sessions)
            .where(eq(sessions.id, session.session_id))
        )[0]?.reason;
      const finalize = (turnId: string, revision: number | null) =>
        gateway.finalize(principalOf(claimed), {
          ...scopeOf(claimed, turnId),
          turn_id: turnId,
          finalize_key: `fin-${turnId}`,
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint:
            revision === null
              ? null
              : {
                  revision,
                  manifest_ref: `s3://bucket/quiesce-${reason}-${revision}.json`,
                  manifest_sha256: "c".repeat(64),
                },
        });

      expect(
        await work.checkpointStateAtomic({
          fence: fenceOf(claimed),
          now: clock,
          pendingReason: reason,
        }),
      ).toEqual({
        outcome: "ok",
        pointer: null,
        restorable: false,
        pendingReason: reason,
      });
      expect(await pending()).toBe(reason);
      // The previous generation stays the one to resume from, and work goes on:
      // new input is taken and the turn completes without a checkpoint.
      expect((await append("while the server runs")).outcome).toBe("accepted");
      expect(await finalize("1", null)).toMatchObject({
        status: "completed",
        checkpoint_revision: null,
      });
      expect(await pending()).toBe(reason);

      // This attempt's own next checkpoint is exactly what was missing.
      const next = await gateway.nextInput(
        principalOf(claimed),
        scopeOf(claimed),
      );
      expect(next.input?.turn_id).toBe("2");
      expect(await finalize("2", 0)).toMatchObject({
        status: "completed",
        checkpoint_revision: 0,
      });
      expect(await pending()).toBeNull();

      // A mirror failure outranks it, and is not replaced by it.
      await gateway.heartbeat(principalOf(claimed), {
        ...scopeOf(claimed),
        attempt_state: "running",
        transcript: { persisted_at: null, mirror_error: "batch 3 dropped" },
      });
      expect(
        await work.checkpointStateAtomic({
          fence: fenceOf(claimed),
          now: clock,
          pendingReason: "tool_in_flight",
        }),
      ).toMatchObject({ pendingReason: "mirror_error" });
      expect(await pending()).toBe("mirror_error");
      expect(await append("after the failure")).toEqual({
        outcome: "checkpoint_unavailable",
        reason: "mirror_error",
      });
    },
  );

  test("checkpointStateAtomic answers the fenced pointer and records only a durable refusal", async () => {
    const { session, claimed } = await claimAndDeliver();
    const work = createPostgresWorkerUnitOfWork(db);
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({
      outcome: "ok",
      pointer: null,
      restorable: false,
      pendingReason: null,
    });
    await gateway.finalize(principalOf(claimed), {
      ...scopeOf(claimed, "1"),
      turn_id: "1",
      finalize_key: "fin",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 0,
        manifest_ref: "s3://bucket/state-0.json",
        manifest_sha256: "a".repeat(64),
      },
    });
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
        pendingReason: "mirror_error",
      }),
    ).toEqual({
      outcome: "ok",
      pointer: {
        committedAt: clock,
        manifestRef: "s3://bucket/state-0.json",
        manifestSha256: "a".repeat(64),
        manifestVersion: null,
        parentRevision: null,
        revision: 0,
        turnId: "1",
        versionsHeld: false,
      },
      // The blocker just recorded makes the pointer untrusted at once.
      restorable: false,
      pendingReason: "mirror_error",
    });
    // The store reads the same pointer, outside any fence.
    expect(
      await createPostgresCheckpointStore(db).readPointer(session.session_id),
    ).toMatchObject({ revision: 0, turnId: "1" });
    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, session.session_id));
    expect(
      await work.checkpointStateAtomic({
        fence: fenceOf(claimed),
        now: clock,
      }),
    ).toEqual({ outcome: "stale_epoch" });
    // A pointer at a revision no row describes is corruption, not "none".
    await db
      .update(sessions)
      .set({ checkpointRevision: 9 })
      .where(eq(sessions.id, session.session_id));
    await expect(
      createPostgresCheckpointStore(db).readPointer(session.session_id),
    ).rejects.toThrow(/revision 9/);
  });

  test("the pointer keeps the manifest version it was committed with", async () => {
    const { session, claimed } = await claimAndDeliver();
    const store = createPostgresCheckpointStore(db);
    expect(
      await commitCheckpoint(db, {
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/versioned-0.json",
          manifest_sha256: "a".repeat(64),
          manifest_version: "v1",
        },
        fence: fenceOf(claimed),
        now: clock,
        sessionId: session.session_id,
        turnId: null,
        versionsHeld: true,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    expect(await store.readPointer(session.session_id)).toMatchObject({
      manifestVersion: "v1",
      revision: 0,
      versionsHeld: true,
    });
    const [row] = await db
      .select({ version: checkpoints.manifestVersion })
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, session.session_id));
    expect(row?.version).toBe("v1");
  });

  test("listCheckpoints returns the revisions below the one asked, newest first, bounded", async () => {
    const { session, claimed } = await claimAndDeliver();
    const store = createPostgresCheckpointStore(db);
    for (const revision of [0, 1, 2, 3]) {
      expect(
        await commitCheckpoint(db, {
          checkpoint: {
            revision,
            manifest_ref: `s3://bucket/listed-${revision}.json`,
            manifest_sha256: String(revision).repeat(64),
            ...(revision === 1 ? {} : { manifest_version: `v${revision}` }),
          },
          fence: fenceOf(claimed),
          now: clock,
          sessionId: session.session_id,
          turnId: null,
          versionsHeld: revision !== 2,
        }),
      ).toEqual({ outcome: "committed", revision });
    }
    const listed = await store.listCheckpoints(session.session_id, {
      belowRevision: 3,
      limit: 2,
    });
    expect(listed).toEqual([
      {
        committedAt: expect.any(Date),
        manifestRef: "s3://bucket/listed-2.json",
        manifestSha256: "2".repeat(64),
        manifestVersion: "v2",
        parentRevision: 1,
        revision: 2,
        turnId: null,
        versionsHeld: false,
      },
      {
        committedAt: expect.any(Date),
        manifestRef: "s3://bucket/listed-1.json",
        manifestSha256: "1".repeat(64),
        manifestVersion: null,
        parentRevision: 0,
        revision: 1,
        turnId: null,
        versionsHeld: true,
      },
    ]);
    expect(
      (
        await store.listCheckpoints(session.session_id, {
          belowRevision: 10,
          limit: 10,
        })
      ).map((row) => row.revision),
    ).toEqual([3, 2, 1, 0]);
    expect(
      await store.listCheckpoints(session.session_id, {
        belowRevision: 0,
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await store.listCheckpoints(session.session_id, {
        belowRevision: 3,
        limit: 0,
      }),
    ).toEqual([]);
    // Another session's rows never leak into this one's list.
    expect(
      await store.listCheckpoints(crypto.randomUUID(), {
        belowRevision: 10,
        limit: 10,
      }),
    ).toEqual([]);
  });

  test("a restore that falls back is recorded on the session and its event stream, and the next commit clears it", async () => {
    const { session, claimed } = await claimAndDeliver();
    const sessionId = session.session_id;
    const fence = fenceOf(claimed);
    const store = createPostgresCheckpointStore(db);
    const work = createPostgresWorkerUnitOfWork(db);
    // Revision 0 was taken before any turn; revision 1 closes turn 1.
    expect(
      await commitCheckpoint(db, {
        checkpoint: {
          revision: 0,
          manifest_ref: "s3://bucket/fallback-0.json",
          manifest_sha256: "a".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    expect(
      await gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed, "1"),
        turn_id: "1",
        finalize_key: "fin",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 1,
          manifest_ref: "s3://bucket/fallback-1.json",
          manifest_sha256: "b".repeat(64),
        },
      }),
    ).toMatchObject({ checkpoint_revision: 1 });

    const row = async () => {
      const [found] = await db
        .select({
          revision: sessions.checkpointFallbackRevision,
          attempt: sessions.checkpointRestoreAttemptId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return found;
    };
    const blocker = () =>
      db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!found) throw new Error("session vanished");
        return pauseBlocker(tx, found);
      });
    const announced = () =>
      db
        .select({ payload: events.payload, attemptId: events.attemptId })
        .from(events)
        .where(
          and(
            eq(events.sessionId, sessionId),
            sql`${events.payload}->>'subtype' = ${CHECKPOINT_RESTORE_FALLBACK}`,
          ),
        );
    const skipped = [{ revision: 1, reason: "manifest object is missing" }];
    const record = (
      pointerRevision: number,
      fallback: { revision: number; skipped: typeof skipped } | null,
    ) =>
      work.recordRestoreBaseAtomic({
        fence,
        now: clock,
        pointerRevision,
        fallback,
      });

    expect(await blocker()).toBeNull();
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await row()).toEqual({ revision: 0, attempt: claimed.attempt_id });
    // A retry is the same announcement, not a second one; a different base
    // for the same pointer is refused; a stale pointer is a conflict.
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await record(1, { revision: 5, skipped })).toEqual({
      outcome: "base_changed",
      recordedRevision: 0,
    });
    expect(await record(0, { revision: 0, skipped })).toEqual({
      outcome: "pointer_moved",
      currentRevision: 1,
    });
    expect(await announced()).toEqual([
      {
        attemptId: null,
        payload: {
          type: "system",
          subtype: CHECKPOINT_RESTORE_FALLBACK,
          attempt_id: claimed.attempt_id,
          pointer_revision: 1,
          restored_revision: 0,
          skipped,
        },
      },
    ]);
    // Turn 1 ran, and the revision the session now runs on does not cover
    // it: a pause may no longer lean on the damaged pointer.
    expect(await blocker()).toBe("checkpoint_unavailable");

    // The same attempt handed the pointer after all is refused too: the
    // object may have come back between two requests, and the worker could
    // restore either plan.
    expect(await record(1, null)).toEqual({
      outcome: "base_changed",
      recordedRevision: 0,
    });

    // Another attempt restoring the pointer puts the session back on it.
    // The row, not a second claim, stands in for that attempt having been
    // the one served before.
    const handedTo = async (attempt: string) => {
      await db
        .update(sessions)
        .set({ checkpointRestoreAttemptId: attempt })
        .where(eq(sessions.id, sessionId));
    };
    await handedTo("att_earlier");
    expect(await record(1, null)).toEqual({ outcome: "ok" });
    expect(await row()).toEqual({
      revision: null,
      attempt: claimed.attempt_id,
    });
    expect(await blocker()).toBeNull();
    // Having been served the pointer, this attempt cannot be handed an
    // earlier revision for it either.
    expect(await record(1, null)).toEqual({ outcome: "ok" });
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "base_changed",
      recordedRevision: 1,
    });

    // The next committed checkpoint clears a fallback as well.
    await handedTo("att_earlier");
    expect(await record(1, { revision: 0, skipped })).toEqual({
      outcome: "ok",
    });
    expect(await announced()).toHaveLength(2);
    expect(
      await commitCheckpoint(db, {
        checkpoint: {
          revision: 2,
          manifest_ref: "s3://bucket/fallback-2.json",
          manifest_sha256: "c".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 2 });
    expect(await row()).toEqual({ revision: null, attempt: null });
    // The commit was built on what the restore handed out, not on the pointer
    // it skipped, and a later fallback walks back along that.
    expect(await store.readPointer(sessionId)).toMatchObject({
      revision: 2,
      parentRevision: 0,
    });
    expect(
      (
        await store.listCheckpoints(sessionId, { belowRevision: 2, limit: 1 })
      )[0],
    ).toMatchObject({ revision: 1, parentRevision: 0 });

    // A fallback another attempt was handed is not what this one runs on:
    // its commit builds on the pointer.
    await db
      .update(sessions)
      .set({
        checkpointFallbackRevision: 0,
        checkpointRestoreAttemptId: "att_earlier",
      })
      .where(eq(sessions.id, sessionId));
    expect(
      await commitCheckpoint(db, {
        checkpoint: {
          revision: 3,
          manifest_ref: "s3://bucket/fallback-3.json",
          manifest_sha256: "d".repeat(64),
        },
        fence,
        now: clock,
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 3 });
    expect(await store.readPointer(sessionId)).toMatchObject({
      revision: 3,
      parentRevision: 2,
    });

    await db
      .update(sessions)
      .set({ leaseEpoch: sql`${sessions.leaseEpoch} + 1` })
      .where(eq(sessions.id, sessionId));
    expect(await record(3, { revision: 0, skipped })).toEqual({
      outcome: "stale_epoch",
    });
    expect(await announced()).toHaveLength(2);
  });
});
