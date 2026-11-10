import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { PlatformPrompt } from "@werft-ai/contracts";
import {
  type EnsureExecutionResult,
  type ExecutionBackend,
  type ExecutionObservation,
  type ExecutionRef,
  hashWorkerToken,
  type LaunchIntent,
  runScheduler,
  type SchedulerLogger,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { enqueueWithin } from "./enqueue.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { insertUnreservedLaunch } from "./testing/launches.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testClaimCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * The claim lifecycle end to end, on the real store and the real claim:
 * the scheduler drives a fake provider, and a worker presents the nonce the
 * provider was created with, the way the gateway's bootstrapClaim does.
 */

const REPOSITORY = {
  repositoryId: "repo-a",
  url: "https://example.invalid/repo.git",
  branch: "main",
};
/** What this host runs: the test connection and the one repository. */
const RUNNABLE = testClaimCatalog([REPOSITORY]);
const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: ReturnType<typeof createPostgresSchedulerStore>;
let work: ReturnType<typeof createPostgresWorkerUnitOfWork>;

/** A provider that holds each container's nonce the way its env would. */
class NonceHoldingBackend implements ExecutionBackend {
  readonly kind = "local_docker" as const;
  readonly containers = new Map<
    string,
    { intent: LaunchIntent; nonce: string; state: "running" }
  >();
  readonly ensured: LaunchIntent[] = [];
  /** Throws after the credential is minted, like a create that failed. */
  failNextCreate = false;
  /** Containers an isolation contract bump left behind. */
  readonly stale = new Set<string>();

  capabilities() {
    return { suspend: false };
  }

  async resolveImage(reference: string): Promise<string> {
    return `sha256:${reference}`;
  }

  async ensureExecution(intent: LaunchIntent): Promise<EnsureExecutionResult> {
    this.ensured.push(intent);
    const key = keyOf(intent);
    const existing = this.containers.get(key);
    if (existing) return { created: false, providerRef: key, state: "running" };
    const nonce = await intent.issueBootstrapNonce();
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("create failed");
    }
    this.containers.set(key, { intent, nonce, state: "running" });
    return { created: true, providerRef: key, state: "running" };
  }

  async inspect(ref: ExecutionRef): Promise<ExecutionObservation> {
    const container = this.containers.get(keyOf(ref));
    return container
      ? {
          found: true,
          observedAt: new Date(),
          providerRef: keyOf(ref),
          state: container.state,
          ...(this.stale.has(keyOf(ref)) ? { stale: true } : {}),
        }
      : {
          found: false,
          observedAt: new Date(),
          providerRef: null,
          state: "unknown",
        };
  }

  async listManaged() {
    return [...this.containers.values()].map(({ intent, state }) => ({
      executionId: intent.executionId,
      generation: intent.generation,
      providerRef: keyOf(intent),
      sessionId: intent.sessionId,
      state,
    }));
  }

  async terminate(ref: ExecutionRef) {
    return this.containers.delete(keyOf(ref))
      ? { outcome: "terminated" as const, providerRef: keyOf(ref) }
      : { outcome: "absent" as const };
  }

  nonceOf(ref: ExecutionRef): string {
    const container = this.containers.get(keyOf(ref));
    if (!container) throw new Error(`no container for ${keyOf(ref)}`);
    return container.nonce;
  }
}

function keyOf(ref: ExecutionRef): string {
  return `${ref.executionId}#${ref.generation}`;
}

const silent: SchedulerLogger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

function pass(backend: ExecutionBackend) {
  return runScheduler({
    backend,
    image: "worker:test",
    logger: silent,
    resources: RESOURCES,
    slotLimit: 10,
    store,
  });
}

/** A release whose runtime_config_snapshot is `snapshot`. */
async function releaseWith(
  snapshot: unknown,
  card: Record<string, unknown> = {},
): Promise<string> {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const id = `rel-${crypto.randomUUID()}`;
  await db.insert(workspaces).values({ id: workspaceId, slug: id, name: id });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: "bot",
    name: "bot",
  });
  await db.insert(agentVersions).values({
    id: versionId,
    agentId,
    versionNo: 1,
    card: {
      role: "r",
      instructions: "i",
      model: "m",
      capabilities: {},
      ...card,
    },
    contentSha256: "0".repeat(64),
  });
  await db.insert(agentReleases).values({
    id,
    agentId,
    versionId,
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: snapshot,
    effectiveTools: [],
  });
  return id;
}

/**
 * A session with one queued turn, waiting for a launch, pinned on the test
 * connection (the spec every test release holds).
 */
async function queuedSession(
  partition = "default",
  agentReleaseId: string | null = null,
  pin = sessionPinColumns(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    admissionState: "active",
    agentReleaseId,
    ...pin,
    branch: REPOSITORY.branch,
    id,
    ownerId: "owner-a",
    partition,
    repoUrl: REPOSITORY.url,
    repositoryId: REPOSITORY.repositoryId,
  });
  await db.insert(turns).values({
    message: "hello",
    sequence: 1,
    sessionId: id,
    status: "queued",
  });
  await db.insert(unassignedSessions).values({ sessionId: id, partition });
  return id;
}

function claim(ref: ExecutionRef, nonce: string) {
  return work.claimAtomic({
    attemptId: `att-${crypto.randomUUID()}`,
    settingsGeneration: null,
    unsettledRepositoryIds: new Set(),
    unsettledConnectionIds: new Set(),
    costLimitUsd: 1_000,
    tokenLimit: null,
    credentialHash: hashWorkerToken(`wkt-${crypto.randomUUID()}`),
    credentialTtlMs: 60_000,
    egress: {
      providerHash: hashWorkerToken(`wep-${crypto.randomUUID()}`),
      repositoryHash: hashWorkerToken(`wer-${crypto.randomUUID()}`),
      objectStoreHash: hashWorkerToken(`weo-${crypto.randomUUID()}`),
      bindingsOf: () => ({
        provider: "provider",
        repository: "repository",
        object_store: "sessions/s/",
      }),
    },
    executionGeneration: ref.generation,
    executionId: ref.executionId,
    leaseTtlMs: 60_000,
    nonceHash: hashWorkerToken(nonce),
    now: new Date(),
    runnable: RUNNABLE,
  });
}

async function launchesOf(sessionId: string) {
  return db
    .select()
    .from(workerLaunches)
    .where(eq(workerLaunches.sessionId, sessionId))
    .orderBy(workerLaunches.generation);
}

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  store = createPostgresSchedulerStore(db, {
    sessionCostLimitUsd: 1_000,
    sessionTokenLimit: null,
    connectForLock: async () => ({
      query: async (text: string) => {
        const result = await client.query<Record<string, unknown>>(text);
        return { rows: result.rows };
      },
      release: () => undefined,
      on: () => undefined,
      off: () => undefined,
    }),
  });
  work = createPostgresWorkerUnitOfWork(db);
});

afterEach(async () => {
  await client.close();
});

describe("claim lifecycle", () => {
  test("the binding carries the release's answer language: only ko, en or ja; follow-user, a release before the field, an unknown value and no release all bind none", async () => {
    const languageBound = async (agentReleaseId: string | null) => {
      const backend = new NonceHoldingBackend();
      await queuedSession("default", agentReleaseId);
      const [ref] = (await pass(backend)).launched;
      if (!ref) throw new Error("nothing launched");
      const bound = await claim(ref, backend.nonceOf(ref));
      if (bound.outcome !== "claimed") throw new Error(bound.outcome);
      return bound.binding.releaseLanguage;
    };
    expect(await languageBound(null)).toBeNull();
    for (const language of ["ko", "en", "ja"] as const) {
      expect(
        await languageBound(await releaseWith({ tools: [], language })),
      ).toBe(language);
    }
    expect(
      await languageBound(
        await releaseWith({ tools: [], language: "follow-user" }),
      ),
    ).toBeNull();
    expect(await languageBound(await releaseWith({ tools: [] }))).toBeNull();
    expect(
      await languageBound(await releaseWith({ tools: [], language: "fr" })),
    ).toBeNull();
  });

  test("the binding carries the session's own spec, verified, and a pin that does not verify is never run as a guess", async () => {
    const bindingOf = async (pin: ReturnType<typeof sessionPinColumns>) => {
      const backend = new NonceHoldingBackend();
      await queuedSession(
        "default",
        await releaseWith({ model: TEST_MODEL, tools: ["Read"] }),
        pin,
      );
      const [ref] = (await pass(backend)).launched;
      if (!ref) throw new Error("nothing launched");
      return claim(ref, backend.nonceOf(ref));
    };
    // A release's own spec, as a session of it holds it.
    const own = await bindingOf(sessionPinColumns());
    if (own.outcome !== "claimed") throw new Error(own.outcome);
    expect(own.binding.spec.connection.id).toBe(TEST_CONNECTION_ID);
    expect(own.binding.model).toBe(TEST_MODEL);
    expect(own.binding.specDigest).toBe(releaseSpecColumns().specDigest);
    // The session's spec, not the release's: the mode is the pin's.
    await client.query("DELETE FROM unassigned_sessions");
    const bypass = await bindingOf(
      sessionPinColumns(TEST_MODEL, { permission_mode: "bypassPermissions" }),
    );
    if (bypass.outcome !== "claimed") throw new Error(bypass.outcome);
    expect(bypass.binding.spec.permission_mode).toBe("bypassPermissions");
    // A pin whose digest does not hold is a broken row, not a spec.
    await client.query("DELETE FROM unassigned_sessions");
    await expect(
      bindingOf({
        ...sessionPinColumns(),
        specDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow(/no spec that verifies/);
  });

  test("the binding carries the session row's platform prompt as stored, and none for a revision 0 row", async () => {
    const promptBound = async (prompt: PlatformPrompt | null) => {
      const backend = new NonceHoldingBackend();
      const sessionId = await queuedSession("default");
      await db
        .update(sessions)
        .set({ platformPrompt: prompt })
        .where(eq(sessions.id, sessionId));
      const [ref] = (await pass(backend)).launched;
      if (!ref) throw new Error("nothing launched");
      const bound = await claim(ref, backend.nonceOf(ref));
      if (bound.outcome !== "claimed") throw new Error(bound.outcome);
      return bound.binding.platformPrompt;
    };
    const prompt: PlatformPrompt = {
      prompt_revision: 1,
      agent_identity: { name: "code-review", description: "Reviews" },
      origin_surface: "slack_dm",
      language: "en",
      repository: "acme/app",
    };
    expect(await promptBound(null)).toBeNull();
    expect(await promptBound(prompt)).toEqual(prompt);
  });

  test("a claimed execution lost after its claim comes back as the next generation with a new nonce; the old nonce claims nothing", async () => {
    const backend = new NonceHoldingBackend();
    const sessionId = await queuedSession();

    const first = await pass(backend);
    expect(first.launched).toHaveLength(1);
    const [gen1] = first.launched;
    if (!gen1) throw new Error("nothing launched");
    const oldNonce = backend.nonceOf(gen1);
    expect((await claim(gen1, oldNonce)).outcome).toBe("claimed");

    // The worker dies and takes its container with it, after the claim.
    backend.containers.delete(keyOf(gen1));
    const second = await pass(backend);

    // The spent launch is closed and never re-created under its own
    // identity. It died before asking for input, so the session it gave back
    // waits out a startup backoff and is then launched again one
    // generation on.
    expect(second.terminatedObserved).toEqual([gen1]);
    expect(second.reensured).toEqual([]);
    expect(second.launched).toEqual([]);
    await db
      .update(sessions)
      .set({ restoreRetryAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(sessions.id, sessionId));
    const third = await pass(backend);
    expect(third.launched).toHaveLength(1);
    const [gen2] = third.launched;
    if (!gen2) throw new Error("nothing relaunched");
    expect(gen2.generation).toBe(gen1.generation + 1);
    expect(gen2.executionId).not.toBe(gen1.executionId);
    const newNonce = backend.nonceOf(gen2);
    expect(newNonce).not.toBe(oldNonce);
    const launches = await launchesOf(sessionId);
    expect(launches.map((l) => l.generation)).toEqual([1, 2]);
    expect(launches[0]?.slotReleasedAt).not.toBeNull();
    expect(launches[1]?.slotReleasedAt).toBeNull();
    const [intent1, intent2] = backend.ensured;
    expect(intent2?.operationId).not.toBe(intent1?.operationId);

    // The old nonce opens neither the launch it was issued for nor the new
    // one; only the new nonce binds the new generation.
    expect((await claim(gen1, oldNonce)).outcome).toBe("invalid_credential");
    expect((await claim(gen2, oldNonce)).outcome).toBe("invalid_credential");
    const bound = await claim(gen2, newNonce);
    expect(bound.outcome).toBe("claimed");
    if (bound.outcome !== "claimed") throw new Error("unreachable");
    expect(bound.binding.executionGeneration).toBe(2);
  });

  test("a create that failed before any claim is retried as the same intent, and only the credential it finally holds is accepted", async () => {
    const backend = new NonceHoldingBackend();
    const sessionId = await queuedSession();
    backend.failNextCreate = true;

    const first = await pass(backend);
    expect(first.launched).toEqual([]);
    expect(first.failedLaunches).toHaveLength(1);
    const [ref] = first.failedLaunches;
    if (!ref) throw new Error("nothing attempted");
    // The failure holds the next attempt back; spent here on the
    // database clock rather than waited out.
    await db
      .update(workerLaunches)
      .set({ launchRetryAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(workerLaunches.executionId, ref.executionId));

    const second = await pass(backend);
    expect(second.reensured).toEqual([ref]);
    expect(second.launched).toEqual([]);
    const [failed, retried] = backend.ensured;
    // The same launch: execution, generation and the provider's idempotency
    // key all carry over. The nonce is minted again on the create path, so
    // whatever the failed create was handed is already dead.
    expect(retried?.executionId).toBe(failed?.executionId ?? "");
    expect(retried?.generation).toBe(1);
    expect(retried?.operationId).toBe(failed?.operationId ?? "");
    expect(await launchesOf(sessionId)).toHaveLength(1);

    expect((await claim(ref, backend.nonceOf(ref))).outcome).toBe("claimed");
  });

  test("a session whose execution in another partition exits idle is signalled back to that partition by its next message", async () => {
    const backend = new NonceHoldingBackend();
    const partition = `p-${crypto.randomUUID()}`;
    const sessionId = await queuedSession(partition);

    const first = await pass(backend);
    const [gen1] = first.launched;
    if (!gen1) throw new Error("nothing launched");
    expect((await launchesOf(sessionId))[0]?.partition).toBe(partition);
    expect((await claim(gen1, backend.nonceOf(gen1))).outcome).toBe("claimed");

    // The turn finishes and the worker exits with nothing left to do: the
    // binding goes away and no signal is left behind.
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    backend.containers.delete(keyOf(gen1));
    expect((await pass(backend)).terminatedObserved).toEqual([gen1]);
    const [idle] = await db
      .select({ executionId: sessions.executionId, podId: sessions.podId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(idle).toEqual({ executionId: null, podId: null });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toEqual([]);

    await db.transaction((tx) =>
      enqueueWithin(tx, { sessionId, payload: { message: "again" } }),
    );
    expect(
      await db
        .select({ partition: unassignedSessions.partition })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toEqual([{ partition }]);
  });

  test("a claim never moves a session: a pool worker in another partition cannot take it, even with its signal rewritten there", async () => {
    const first = `p-${crypto.randomUUID()}`;
    const sessionId = await queuedSession(first);
    const second = `p-${crypto.randomUUID()}`;
    await db
      .update(unassignedSessions)
      .set({ partition: second })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const pool = await insertUnreservedLaunch(db, { partition: second });

    expect((await claim(pool, pool.nonce)).outcome).toBe("no_session");
    expect(
      await db
        .select({ partition: sessions.partition, podId: sessions.podId })
        .from(sessions)
        .where(eq(sessions.id, sessionId)),
    ).toEqual([{ partition: first, podId: null }]);
  });

  test("a claimed container an isolation contract bump made stale stays up while its turn runs, and is replaced once the turn has ended", async () => {
    const backend = new NonceHoldingBackend();
    const sessionId = await queuedSession();
    const [gen1] = (await pass(backend)).launched;
    if (!gen1) throw new Error("nothing launched");
    expect((await claim(gen1, backend.nonceOf(gen1))).outcome).toBe("claimed");
    // Its worker is past its first poll and runs the turn.
    await db
      .update(sessions)
      .set({ restoreAttemptId: null })
      .where(eq(sessions.id, sessionId));
    await db
      .update(turns)
      .set({ status: "running" })
      .where(eq(turns.sessionId, sessionId));

    backend.stale.add(keyOf(gen1));
    const draining = await pass(backend);
    expect(draining.draining).toEqual([gen1]);
    expect(draining.replaced).toEqual([]);
    expect(backend.containers.has(keyOf(gen1))).toBe(true);

    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    const replaced = await pass(backend);
    expect(replaced.draining).toEqual([]);
    expect(replaced.drainsOverdue).toEqual([]);
    expect(replaced.replaced).toEqual([gen1]);
    expect(backend.containers.has(keyOf(gen1))).toBe(false);
    const [session] = await db
      .select({
        executionId: sessions.executionId,
        restoreFailureCount: sessions.restoreFailureCount,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toEqual({ executionId: null, restoreFailureCount: 0 });
  });
});
