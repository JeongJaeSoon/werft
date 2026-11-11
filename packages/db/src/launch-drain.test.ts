import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import { executions, sessions, workerLaunches } from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * a claimed worker whose resource an isolation contract bump made
 * stale is drained, not torn down mid-turn. The store's half: the request
 * stops new turns from being handed out, and says whether one is still open.
 */

const PROFILE_ID = "claude-coding-v1";
const OWNER = testCaller("owner-a");
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: {
    [PROFILE_ID]: {
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
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: [PROFILE_ID],
      auth: { kind: "github_app", registered: true },
    },
  },
});
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: CATALOG,
    checkpoints: {
      async verify() {
        return { status: "verified" };
      },
    },
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
      sleep: async () => {},
    },
  });
});

afterEach(async () => {
  await client.close();
});

function schedulerStore() {
  return createPostgresSchedulerStore(db, {
    sessionCostLimitUsd: 1_000,
    sessionTokenLimit: null,
    connectForLock: async () => {
      throw new Error("not used");
    },
  });
}

/** A session with its first input, bound to a claimed, pinned launch. */
async function claimedSession() {
  const service = createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: CATALOG,
    limits: { ...LIMITS, sessionCostLimitUsd: 1_000, sessionTokenLimit: null },
  });
  const created = await service.createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
      message: "first input",
    },
  });
  const sessionId = created.session_id;
  const { executionId, generation, nonce } = await launchSession(db, {
    sessionId,
  });
  const claimed = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    },
  );
  const principal: WorkerPrincipal = {
    kind: "session",
    attemptId: claimed.attempt_id,
    sessionId,
    leaseEpoch: claimed.lease_epoch,
    executionGeneration: claimed.execution_generation,
    authRevision: claimed.auth_revision,
  };
  const scope = {
    session_id: sessionId,
    turn_id: null,
    attempt_id: claimed.attempt_id,
    lease_epoch: claimed.lease_epoch,
    execution_generation: claimed.execution_generation,
    auth_revision: claimed.auth_revision,
  };
  return { sessionId, ref: { executionId, generation: 1 }, principal, scope };
}

async function append(sessionId: string, message: string) {
  const appended = await createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: OWNER,
    sessionId,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    message,
    limits: LIMITS,
  });
  expect(appended.outcome).toBe("accepted");
}

async function drainRequestedAt(executionId: string) {
  const [row] = await db
    .select({ at: workerLaunches.drainRequestedAt })
    .from(workerLaunches)
    .where(eq(workerLaunches.executionId, executionId));
  return row?.at ?? null;
}

describe("launch drain", () => {
  test("the turn running when the drain is asked for is the worker's last: open until it ends, and no new one is handed out", async () => {
    const { sessionId, ref, principal, scope } = await claimedSession();
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
    await append(sessionId, "second input");

    const store = schedulerStore();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: false,
    });
    const requestedAt = await drainRequestedAt(ref.executionId);
    expect(requestedAt).not.toBeNull();
    // Asked again: the first time stands.
    await store.requestDrain(ref, 60_000);
    expect(await drainRequestedAt(ref.executionId)).toEqual(requestedAt);

    // The turn it holds is still its own to finish, redelivered as ever.
    expect((await gateway.nextInput(principal, scope)).input?.turn_id).toBe(
      first.input.turn_id,
    );
    await gateway.finalize(principal, {
      ...scope,
      turn_id: first.input.turn_id,
      finalize_key: `${scope.attempt_id}:${first.input.turn_id}`,
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
      },
      checkpoint: null,
    });
    // The second input waits for the replacement.
    expect((await gateway.nextInput(principal, scope)).input).toBeNull();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: false,
      overdue: false,
    });
  });

  test("a worker still starting up is busy until its first poll, which hands it no turn", async () => {
    const { ref, principal, scope } = await claimedSession();
    const store = schedulerStore();
    // Claimed and restoring: torn down now, it would count as a failed
    // startup.
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: false,
    });
    expect((await gateway.nextInput(principal, scope)).input).toBeNull();
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: false,
      overdue: false,
    });
    const [session] = await db
      .select({
        restoreAttemptId: sessions.restoreAttemptId,
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.executionId, ref.executionId));
    expect(session).toEqual({ restoreAttemptId: null, status: "queued" });
  });

  test("a drain older than the deadline is overdue, on the database clock", async () => {
    const { ref, principal, scope } = await claimedSession();
    expect((await gateway.nextInput(principal, scope)).input).not.toBeNull();
    const store = schedulerStore();
    await store.requestDrain(ref, 60_000);
    await db
      .update(workerLaunches)
      .set({ drainRequestedAt: new Date(Date.now() - 61_000) })
      .where(eq(workerLaunches.executionId, ref.executionId));
    expect(await store.requestDrain(ref, 60_000)).toEqual({
      busy: true,
      overdue: true,
    });
  });

  test("a launch with no binding, or asked to go, is not drained", async () => {
    const { ref } = await claimedSession();
    const store = schedulerStore();
    await db
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, ref.executionId));
    expect(await store.requestDrain(ref, 60_000)).toBeNull();
    expect(
      await store.requestDrain({ ...ref, generation: 2 }, 60_000),
    ).toBeNull();
    expect(await drainRequestedAt(ref.executionId)).toBeNull();
  });
});
