import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { launchNonceFingerprint } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import {
  attempts,
  events,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "../schema.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: ReturnType<typeof createPostgresSchedulerStore>;
let logSink: MemoryLogSink;
const NOW = new Date("2026-09-22T00:00:00Z");
/** What the scheduler pins a launch to; the store only keeps it. */
const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};
const DAY_MS = 24 * 60 * 60 * 1_000;
const DAY = { stoppedTtlMs: DAY_MS };

async function insertUnassigned(
  overrides: Partial<typeof sessions.$inferInsert> = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: "owner-a",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${id}`,
    ...overrides,
  });
  await db.insert(unassignedSessions).values({ sessionId: id });
  return id;
}

/** A launch that predates the intent columns: registered, never relaunchable. */
async function seedLaunch(
  executionId: string,
  sessionId: string,
  backend: string,
): Promise<void> {
  await db.insert(executions).values({
    backend,
    desiredState: "running",
    generation: 1,
    id: executionId,
    observedState: "running",
    sessionId,
  });
  await db.insert(workerLaunches).values({
    backend,
    executionId,
    generation: 1,
    sessionId,
  });
}

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  logSink = new MemoryLogSink();
  store = createPostgresSchedulerStore(db, {
    sessionCostLimitUsd: 1_000,
    sessionTokenLimit: null,
    connectForLock: async () => ({
      query: async (text: string) => {
        const result = await client.query<Record<string, unknown>>(text);
        return { rows: result.rows };
      },
      release: () => undefined,
      // One in-process session: its connection never drops.
      on: () => undefined,
      off: () => undefined,
    }),
    logger: new StructuredLogger({ sinks: [logSink] }),
  });
});

afterEach(async () => {
  await client.close();
});

describe("PostgresSchedulerStore", () => {
  test("reserveLaunch commits one intent per session and refuses a second live one", async () => {
    const sessionId = await insertUnassigned();
    const first = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(first).toMatchObject({ generation: 1, sessionId });
    expect(first?.executionId).toMatch(/^exec-[0-9a-f-]{36}$/);

    const second = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(executions)
      .where(eq(executions.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      launchOperationId: first?.operationId,
      observedState: "pending",
      providerRef: null,
    });
    // The same transaction registered the launch: one row, one slot, and no
    // credential until a container is created for it.
    const launches = await db.select().from(workerLaunches);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      backend: "local_docker",
      claimedAttemptId: null,
      executionId: first?.executionId,
      generation: 1,
      nonceExpiresAt: null,
      nonceHash: null,
      partition: "default",
      sessionId,
      slotReleasedAt: null,
    });
    const [session] = await db
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.executionId).toBe(first?.executionId ?? "");
    // The signal stays until a worker claims the session.
    expect(await db.select().from(unassignedSessions)).toHaveLength(1);
  });

  test("a new generation follows a terminated one", async () => {
    const sessionId = await insertUnassigned();
    const first = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!first) throw new Error("no intent");
    await store.confirmExecutionGone(first.executionId, NOW, null);
    const second = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(second).toMatchObject({ generation: 2, sessionId });
    expect(second?.operationId).not.toBe(first.operationId);
    expect(second?.executionId).not.toBe(first.executionId);
  });

  test("reserveLaunch refuses sessions that are not signalled or not admission-active", async () => {
    const paused = await insertUnassigned({ admissionState: "paused" });
    expect(
      await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId: paused,
        slotLimit: 10,
      }),
    ).toBeNull();

    const claimed = await insertUnassigned();
    await db
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, claimed));
    expect(
      await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId: claimed,
        slotLimit: 10,
      }),
    ).toBeNull();

    expect(
      await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId: crypto.randomUUID(),
        slotLimit: 10,
      }),
    ).toBeNull();
  });

  test("inspectDemand lists eligible sessions oldest first and counts live executions", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await insertUnassigned());
    await db
      .update(unassignedSessions)
      .set({ signaledAt: new Date("2026-09-21T00:00:00Z") })
      .where(eq(unassignedSessions.sessionId, ids[3] ?? ""));
    await insertUnassigned({ admissionState: "stopping" });

    const launched = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId: ids[0] ?? "",
      slotLimit: 10,
    });
    if (!launched) throw new Error("no intent");

    const demand = await store.inspectDemand({ limit: 10 });
    expect(demand.activeExecutionCount).toBe(1);
    expect(demand.eligibleSessionIds[0]).toBe(ids[3]);
    expect(demand.eligibleSessionIds).toHaveLength(3);
    expect(demand.eligibleSessionIds).not.toContain(ids[0]);

    expect(await store.inspectDemand({ limit: 2 })).toMatchObject({
      activeExecutionCount: 1,
      eligibleSessionIds: [ids[3], expect.any(String)],
    });
    // The next page past sessions a pass already passed over.
    expect(
      (
        await store.inspectDemand({
          limit: 10,
          excluding: demand.eligibleSessionIds.slice(0, 2),
        })
      ).eligibleSessionIds,
    ).toEqual(demand.eligibleSessionIds.slice(2));
    expect(await store.inspectDemand({ limit: 0 })).toEqual({
      activeExecutionCount: 1,
      eligibleSessionIds: [],
    });

    // Recording the exit is not releasing the slot; only confirming it is.
    await store.recordObservation(launched, {
      found: true,
      observedAt: NOW,
      providerRef: "ctr",
      state: "terminated",
    });
    expect(
      (await store.inspectDemand({ limit: 10 })).activeExecutionCount,
    ).toBe(1);

    await store.confirmExecutionGone(launched.executionId, NOW, null);
    const after = await store.inspectDemand({ limit: 10 });
    expect(after.activeExecutionCount).toBe(0);
    expect(after.eligibleSessionIds).toContain(ids[0] ?? "");
  });

  test("confirmExecutionGone emits the terminate result through the scheduler store logger", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const controlId = crypto.randomUUID();
    await db
      .update(sessions)
      .set({ admissionState: "stopping" })
      .where(eq(sessions.id, sessionId));
    await db
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, intent.executionId));
    await db.insert(receipts).values({
      id: controlId,
      ownerId: "owner-a",
      operation: "terminate",
      targetRef: { session_id: sessionId },
      createdAt: new Date(NOW.getTime() - 1_000),
    });

    await store.confirmExecutionGone(intent.executionId, NOW, null);

    expect(logSink.records).toContainEqual(
      expect.objectContaining({
        event: "control.result",
        fields: expect.objectContaining({
          control_id: controlId,
          operation: "terminate",
          outcome: "succeeded",
          reason_code: "execution_gone",
          session_id: sessionId,
        }),
      }),
    );
  });

  test("listActiveExecutions returns open launches and, for this backend, ones without an intent", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const foreign = await insertUnassigned();
    await seedLaunch("exec-other", foreign, "kubernetes");
    const legacySession = await insertUnassigned();
    await seedLaunch("exec-legacy", legacySession, "local_docker");
    // An executions row nobody registered is not in the ledger at all: its
    // resource has no launch, so the pass reclaims it as an orphan instead.
    const strandedSession = await insertUnassigned();
    await db.insert(executions).values({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      id: "exec-stranded",
      observedState: "running",
      sessionId: strandedSession,
    });

    const active = await store.listActiveExecutions("local_docker");
    expect(active).toEqual([
      {
        backend: "local_docker",
        claimed: false,
        desiredState: "running",
        executionId: intent.executionId,
        generation: 1,
        // Handed back exactly as the reservation stored it.
        image: SPEC.image,
        launchAttempts: 0,
        launchFailureCount: 0,
        launchRetryAt: null,
        launchRetryDue: true,
        nonceExpired: false,
        nonceExpiresAt: null,
        nonceFingerprint: null,
        observedAt: null,
        observedState: "pending",
        operationId: intent.operationId,
        pendingReplacement: null,
        providerRef: null,
        replacementCount: 0,
        resources: SPEC.resources,
        sessionId,
      },
      {
        backend: "local_docker",
        claimed: false,
        desiredState: "running",
        executionId: "exec-legacy",
        generation: 1,
        image: null,
        launchAttempts: 0,
        launchFailureCount: 0,
        launchRetryAt: null,
        launchRetryDue: true,
        nonceExpired: false,
        nonceExpiresAt: null,
        nonceFingerprint: null,
        observedAt: null,
        observedState: "running",
        operationId: null,
        pendingReplacement: null,
        providerRef: null,
        replacementCount: 0,
        resources: null,
        sessionId: legacySession,
      },
    ]);
    // Three launches hold slots; the stranded executions row holds none.
    expect((await store.inspectDemand({ limit: 1 })).activeExecutionCount).toBe(
      3,
    );
  });

  test("another backend's intent is not ours", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "kubernetes",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(await store.listActiveExecutions("local_docker")).toEqual([]);
    expect(await store.filterKnown([intent], "local_docker")).toEqual([]);
    expect(await store.filterKnown([intent], "kubernetes")).toEqual([intent]);
  });

  test("recordObservation updates state, time and provider ref for the exact generation", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const at = new Date("2026-09-22T00:01:00Z");
    await store.recordObservation(intent, {
      found: true,
      observedAt: at,
      providerRef: "ctr-abc",
      state: "running",
    });
    await store.recordObservation(
      { ...intent, generation: 9 },
      { found: false, observedAt: at, providerRef: null, state: "unknown" },
    );
    const [row] = await db
      .select()
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(row).toMatchObject({
      observedAt: at,
      observedState: "running",
      providerRef: "ctr-abc",
    });

    // A not-found observation keeps the last provider ref for the audit trail.
    await store.recordObservation(intent, {
      found: false,
      observedAt: at,
      providerRef: null,
      state: "unknown",
    });
    const [again] = await db
      .select({
        providerRef: executions.providerRef,
        state: executions.observedState,
      })
      .from(executions)
      .where(eq(executions.id, intent.executionId));
    expect(again).toEqual({ providerRef: "ctr-abc", state: "unknown" });
  });

  test("reserveLaunch refuses once open launches reach the slot limit", async () => {
    const a = await insertUnassigned();
    const b = await insertUnassigned();
    const first = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId: a,
      slotLimit: 1,
    });
    expect(first).not.toBeNull();
    expect(
      await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId: b,
        slotLimit: 1,
      }),
    ).toBeNull();
    if (!first) throw new Error("no intent");
    await store.confirmExecutionGone(first.executionId, NOW, null);
    expect(
      await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId: b,
        slotLimit: 1,
      }),
    ).not.toBeNull();
  });

  test("reserving and releasing in turn always comes back to zero slots", async () => {
    const reserved = async () =>
      (await store.inspectDemand({ limit: 0 })).activeExecutionCount;
    const sessionId = await insertUnassigned();
    for (let round = 0; round < 4; round += 1) {
      const intent = await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId,
        slotLimit: 1,
      });
      if (!intent) throw new Error(`round ${round} reserved nothing`);
      expect(await reserved()).toBe(1);
      // A launch that never came back would be counted twice by anyone
      // keeping a second ledger; with one, the limit of 1 proves it.
      await store.issueBootstrapNonce(intent);
      expect(await reserved()).toBe(1);
      await store.confirmExecutionGone(intent.executionId, NOW, null);
      expect(await reserved()).toBe(0);
    }
  });

  test("issueBootstrapNonce stores only a hash, rotates it, and stops once claimed", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");

    const floor = Date.now();
    const first = await store.issueBootstrapNonce(intent);
    const ceiling = Date.now();
    expect(first).toMatch(/^wln_/);
    const [stored] = await db
      .select()
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(stored?.nonceHash).toEqual(sha256(first));
    // The expiry is written on the database clock (PGlite shares this
    // process's), never on a clock the caller passes in.
    const expiresAt = stored?.nonceExpiresAt?.getTime() ?? Number.NaN;
    expect(expiresAt).toBeGreaterThanOrEqual(floor + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(ceiling + 600_000);
    // Nothing anywhere holds the plaintext.
    expect(JSON.stringify(stored)).not.toContain(first);
    // The scheduler reads the expiry back, already judged on the database
    // clock, to decide when a resource that never claimed has to be
    // replaced rather than waited on.
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active?.nonceExpiresAt).toEqual(stored?.nonceExpiresAt ?? null);
    expect(active?.nonceExpired).toBe(false);

    const second = await store.issueBootstrapNonce(intent);
    expect(second).not.toBe(first);
    const [rotated] = await db
      .select({ nonceHash: workerLaunches.nonceHash })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(rotated?.nonceHash).toEqual(sha256(second));

    // A generation that is not this launch's, and a launch whose slot is
    // already back, are both refused.
    await expect(
      store.issueBootstrapNonce({ ...intent, generation: 9 }),
    ).rejects.toThrow("no bootstrap credential was issued");
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    await expect(store.issueBootstrapNonce(intent)).rejects.toThrow(
      "no bootstrap credential was issued",
    );
  });

  test("bootstrapCredentialState follows the stored hash, the claim, and the slot", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    // Reserved, nothing issued: nothing can match.
    expect(await store.bootstrapCredentialState(intent)).toEqual({
      claimed: false,
      fingerprint: null,
    });

    const nonce = await store.issueBootstrapNonce(intent);
    const state = await store.bootstrapCredentialState(intent);
    // The fingerprint is a function of the column alone, so a backend that
    // labels its container with the same function of the plaintext's hash
    // can be judged against the registry without either side holding the
    // plaintext — and the value is neither the plaintext nor the column.
    expect(state).toEqual({
      claimed: false,
      fingerprint: launchNonceFingerprint(sha256(nonce)),
    });
    if (state.claimed) throw new Error("unreachable");
    expect(state.fingerprint).not.toContain(nonce);
    expect(state.fingerprint).not.toBe(
      Buffer.from(sha256(nonce)).toString("hex"),
    );
    // Rotation moves it; the old fingerprint stops matching.
    const rotated = await store.issueBootstrapNonce(intent);
    expect(await store.bootstrapCredentialState(intent)).toEqual({
      claimed: false,
      fingerprint: launchNonceFingerprint(sha256(rotated)),
    });
    // What the scheduler holds a running resource's label against.
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active?.nonceFingerprint).toBe(
      launchNonceFingerprint(sha256(rotated)),
    );
    // Another generation is another launch, and not one the registry holds.
    await expect(
      store.bootstrapCredentialState({ ...intent, generation: 9 }),
    ).rejects.toThrow("released or unknown");

    // Once a worker has bound, the label no longer decides anything.
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: intent.generation,
      executionId: intent.executionId,
      id: "att-state",
      leaseEpoch: 1,
      leaseExpiresAt: NOW,
      sessionId,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-state" })
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(await store.bootstrapCredentialState(intent)).toEqual({
      claimed: true,
    });

    // A launch that gave its slot back is not one to replace a resource for.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    await expect(store.bootstrapCredentialState(intent)).rejects.toThrow(
      "released or unknown",
    );
  });

  test("revokeBootstrapNonce shuts the door only while it is still open", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const nonce = await store.issueBootstrapNonce(intent);
    const hashOf = async () => {
      const [row] = await db
        .select({ nonceHash: workerLaunches.nonceHash })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, intent.executionId));
      return row?.nonceHash ?? null;
    };

    // Inside the window there is nothing to revoke: a worker may still be on
    // its way, and the credential it was built with has to keep working.
    expect(await store.revokeBootstrapNonce(intent)).toBe(false);
    expect(await hashOf()).toEqual(sha256(nonce));

    // Expiry is judged on the database clock, so the window is closed by
    // moving the deadline into the past rather than by passing a later time.
    const expired = new Date(Date.now() - 1);
    const expire = async (executionId: string) =>
      db
        .update(workerLaunches)
        .set({ nonceExpiresAt: expired })
        .where(eq(workerLaunches.executionId, executionId));
    await expire(intent.executionId);
    const [listed] = await store.listActiveExecutions("local_docker");
    expect(listed?.nonceExpired).toBe(true);
    expect(await store.revokeBootstrapNonce(intent)).toBe(true);
    expect(await hashOf()).toBeNull();
    // Idempotent on purpose: a teardown that fails after the revoke leaves
    // the launch here, and the next pass has to be able to try again.
    expect(await store.revokeBootstrapNonce(intent)).toBe(true);

    // A claim that committed first wins outright, however stale the expiry.
    const claimed = await insertUnassigned();
    const other = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId: claimed,
      slotLimit: 10,
    });
    if (!other) throw new Error("no intent");
    await store.issueBootstrapNonce(other);
    await expire(other.executionId);
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: other.generation,
      executionId: other.executionId,
      id: "att-1",
      leaseEpoch: 1,
      leaseExpiresAt: expired,
      sessionId: claimed,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-1" })
      .where(eq(workerLaunches.executionId, other.executionId));
    expect(await store.revokeBootstrapNonce(other)).toBe(false);

    // So does a launch whose slot already went back, and a stale generation.
    expect(await store.revokeBootstrapNonce({ ...intent, generation: 9 })).toBe(
      false,
    );
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await store.revokeBootstrapNonce(intent)).toBe(false);
  });

  test("requestReplacement records the intent, counts it, shuts the door, and refuses a launch that moved on", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    await store.issueBootstrapNonce(intent);
    const launchRow = async () => {
      const [row] = await db
        .select({
          nonceHash: workerLaunches.nonceHash,
          replacementCount: workerLaunches.replacementCount,
          replacementReason: workerLaunches.replacementReason,
        })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, intent.executionId));
      return row;
    };
    const active = async () =>
      (await store.listActiveExecutions("local_docker")).find(
        (row) => row.executionId === intent.executionId,
      );

    expect(await active()).toMatchObject({
      pendingReplacement: null,
      replacementCount: 0,
    });

    expect(await store.requestReplacement(intent, "stale_isolation", 0)).toBe(
      1,
    );
    // The credential the old resource holds matches nothing from here on.
    expect(await launchRow()).toMatchObject({
      nonceHash: null,
      replacementCount: 1,
      replacementReason: "stale_isolation",
    });
    expect(await active()).toMatchObject({
      pendingReplacement: "stale_isolation",
      replacementCount: 1,
    });

    // A request from a stale snapshot — a pass that lost its lock — is
    // refused rather than counted twice.
    expect(
      await store.requestReplacement(intent, "nonce_expired", 0),
    ).toBeNull();
    // Fenced on the credential: the door is shut, so only "no credential"
    // matches; a fingerprint from before the shut is refused.
    expect(
      await store.requestReplacement(
        intent,
        "credential_mismatch",
        1,
        launchNonceFingerprint(new Uint8Array(32)),
      ),
    ).toBeNull();
    expect((await launchRow())?.replacementCount).toBe(1);
    const reissued = await store.issueBootstrapNonce(intent);
    const reissuedFingerprint = launchNonceFingerprint(
      createHash("sha256").update(reissued).digest(),
    );
    expect(
      await store.requestReplacement(intent, "credential_mismatch", 1, null),
    ).toBeNull();
    expect(
      await store.requestReplacement(
        intent,
        "credential_mismatch",
        1,
        reissuedFingerprint,
      ),
    ).toBe(2);
    expect((await launchRow())?.nonceHash).toBeNull();
    // Back to the unfenced path for the rest.
    await store.settleReplacement(intent, 2);
    expect(await active()).toMatchObject({
      pendingReplacement: null,
      replacementCount: 2,
    });
    // A second request counts again and carries the latest reason.
    expect(await store.requestReplacement(intent, "nonce_expired", 2)).toBe(3);
    expect(await active()).toMatchObject({
      pendingReplacement: "nonce_expired",
      replacementCount: 3,
    });

    // Settling clears the reason and keeps the count.
    await store.settleReplacement(intent, 3);
    expect(await active()).toMatchObject({
      pendingReplacement: null,
      replacementCount: 3,
    });

    // A stale generation is not this launch.
    expect(
      await store.requestReplacement(
        { ...intent, generation: 9 },
        "stale_isolation",
        3,
      ),
    ).toBeNull();
    // Neither is one whose slot went back.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(
      await store.requestReplacement(intent, "stale_isolation", 3),
    ).toBeNull();
    expect((await launchRow())?.replacementCount).toBe(3);

    // Nor one that bound a worker: its resource is not to be rebuilt.
    const claimedSession = await insertUnassigned();
    const other = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId: claimedSession,
      slotLimit: 10,
    });
    if (!other) throw new Error("no intent");
    const nonce = await store.issueBootstrapNonce(other);
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: other.generation,
      executionId: other.executionId,
      id: "att-replace",
      leaseEpoch: 1,
      leaseExpiresAt: NOW,
      sessionId: claimedSession,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-replace" })
      .where(eq(workerLaunches.executionId, other.executionId));
    expect(
      await store.requestReplacement(other, "stale_isolation", 0),
    ).toBeNull();
    const [kept] = await db
      .select({ nonceHash: workerLaunches.nonceHash })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, other.executionId));
    // Refused means untouched: the worker's credential is still there.
    expect(kept?.nonceHash).toEqual(sha256(nonce));
  });

  test("a launch with a pending replacement cannot be confirmed gone until it settles", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const holdsSlot = async () =>
      (await store.listActiveExecutions("local_docker")).some(
        (row) => row.executionId === intent.executionId,
      );

    expect(await store.requestReplacement(intent, "stale_isolation", 0)).toBe(
      1,
    );
    // Someone else — a reconciler that saw the old container exit — reports
    // it gone while the scheduler is between teardown and create. The plan
    // wins: the slot and the session stay with this launch.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await holdsSlot()).toBe(true);
    const [session] = await db
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.executionId).toBe(intent.executionId);

    // Once the rebuilt resource is up, an exit is an exit again.
    await store.settleReplacement(intent, 1);
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await holdsSlot()).toBe(false);
  });

  test("confirmExecutionGone with another incarnation is a no-op", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const incarnationOf = (nonce: string | null) => ({
      nonceFingerprint:
        nonce === null ? null : launchNonceFingerprint(sha256(nonce)),
    });
    const holdsSlot = async () =>
      (await store.listActiveExecutions("local_docker")).some(
        (row) => row.executionId === intent.executionId,
      );
    const boundSession = async () =>
      (
        await db
          .select({ executionId: sessions.executionId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.executionId;

    // The resource a stale pass watched go, then the replacement another
    // pass created for the same launch, whose worker bound.
    const old = await store.issueBootstrapNonce(intent);
    const current = await store.issueBootstrapNonce(intent);
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: intent.generation,
      executionId: intent.executionId,
      id: "att-current",
      leaseEpoch: 1,
      leaseExpiresAt: NOW,
      sessionId,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-current" })
      .where(eq(workerLaunches.executionId, intent.executionId));

    for (const seen of [incarnationOf(old), incarnationOf(null)]) {
      expect(
        await store.confirmExecutionGone(intent.executionId, NOW, seen),
      ).toBe("superseded");
      expect(await holdsSlot()).toBe(true);
      expect(await boundSession()).toBe(intent.executionId);
      const [attempt] = await db
        .select({ state: attempts.state })
        .from(attempts)
        .where(eq(attempts.id, "att-current"));
      expect(attempt?.state).toBe("running");
    }
    // An unknown launch names no incarnation at all.
    expect(
      await store.confirmExecutionGone("exec-unknown", NOW, incarnationOf(old)),
    ).toBe("superseded");

    // The claim kept the credential, so the incarnation the worker bound on
    // is still the launch's and its exit is an exit.
    expect(
      await store.confirmExecutionGone(
        intent.executionId,
        NOW,
        incarnationOf(current),
      ),
    ).toBe("confirmed");
    expect(await holdsSlot()).toBe(false);
    expect(await boundSession()).toBeNull();
  });

  test("a row-read incarnation also carries the claim it showed", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    // A pass read the launch unclaimed with this credential and saw no
    // resource; the create that issued it then built one and its worker
    // bound. The fingerprint alone still matches.
    const nonce = await store.issueBootstrapNonce(intent);
    const seen = {
      claimed: false,
      nonceFingerprint: launchNonceFingerprint(sha256(nonce)),
    };
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: intent.generation,
      executionId: intent.executionId,
      id: "att-late",
      leaseEpoch: 1,
      leaseExpiresAt: NOW,
      sessionId,
      state: "running",
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "att-late" })
      .where(eq(workerLaunches.executionId, intent.executionId));

    expect(
      await store.confirmExecutionGone(intent.executionId, NOW, seen),
    ).toBe("superseded");
    expect(await store.listActiveExecutions("local_docker")).toHaveLength(1);
    expect(
      await store.confirmExecutionGone(intent.executionId, NOW, {
        ...seen,
        claimed: true,
      }),
    ).toBe("confirmed");
    expect(await store.listActiveExecutions("local_docker")).toEqual([]);
  });

  test("a launch asked to go is killed, never rebuilt or held for a rebuild", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    await store.issueBootstrapNonce(intent);
    // A replacement recorded, and then a terminate: the kill must be able
    // to confirm the resource gone although the reason is still set.
    expect(await store.requestReplacement(intent, "stale_isolation", 0)).toBe(
      1,
    );
    await db
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, intent.executionId));
    // And a replacement asked for after the terminate is refused outright.
    await store.settleReplacement(intent, 1);
    expect(
      await store.requestReplacement(intent, "stale_isolation", 1),
    ).toBeNull();
    const [launch] = await db
      .select({ reason: workerLaunches.replacementReason })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(launch?.reason).toBeNull();

    // A reason that got in anyway — before the terminate, and never
    // cleared — does not hold the killed launch's slot.
    await db
      .update(workerLaunches)
      .set({ replacementReason: "stale_isolation" })
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(
      await store.confirmExecutionGone(intent.executionId, NOW, null),
    ).toBe("confirmed");
    expect(await store.listActiveExecutions("local_docker")).toEqual([]);
  });

  /** A queued turn as an append leaves it: turn, queue row, input receipt. */
  async function queueInput(sessionId: string, sequence: number) {
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence,
        message: `m${sequence}`,
        status: "queued",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    await db.insert(queueMessages).values({
      sessionId,
      turnId: turn.id,
      kind: "user_message",
      payload: { text: `m${sequence}` },
    });
    const receiptId = crypto.randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: "owner-a",
      operation: sequence === 1 ? "create_session" : "append_message",
      targetRef: { session_id: sessionId, turn_id: String(sequence) },
      result: { turn_id: String(sequence), receipt_status: "accepted" },
    });
    return { receiptId, turnId: turn.id };
  }

  const FAILURE = {
    error: "Image worker:gone is not on this daemon",
    expectedAttempts: 0,
    quarantine: false,
    retryDelayMs: 60_000,
  };

  test("recordLaunchFailure counts, revokes the credential, and holds the next attempt back", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const nonce = await store.issueBootstrapNonce(intent);

    const floor = Date.now();
    expect(
      await store.recordLaunchFailure(intent, {
        ...FAILURE,
        error: "x".repeat(5_000),
        expectedCount: 0,
      }),
    ).toBe("backing_off");
    const [row] = await db
      .select()
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(row?.launchFailureCount).toBe(1);
    expect(row?.nonceHash).toBeNull();
    expect(row?.lastLaunchError).toHaveLength(1_000);
    expect(row?.launchRetryAt?.getTime()).toBeGreaterThanOrEqual(
      floor + 60_000,
    );
    expect(row?.slotReleasedAt).toBeNull();
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active).toMatchObject({
      launchFailureCount: 1,
      launchRetryDue: false,
    });
    // While it waits, no credential: a pass that lost its lock cannot
    // reopen the launch.
    await expect(store.issueBootstrapNonce(intent)).rejects.toThrow(
      "no bootstrap credential was issued",
    );

    // The same failure judged again from the old snapshot is not counted.
    expect(
      await store.recordLaunchFailure(intent, { ...FAILURE, expectedCount: 0 }),
    ).toBe("stale");
    // A dead resource built with the revoked credential is not counted
    // either, whatever count the caller read.
    expect(
      await store.recordLaunchFailure(intent, {
        ...FAILURE,
        expectedAttempts: 1,
        expectedCount: 1,
        expectedNonceFingerprint: launchNonceFingerprint(sha256(nonce)),
      }),
    ).toBe("stale");

    await db
      .update(workerLaunches)
      .set({ launchRetryAt: new Date(Date.now() - 1_000) })
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect((await store.listActiveExecutions("local_docker"))[0]).toMatchObject(
      { launchRetryDue: true },
    );
    await expect(store.issueBootstrapNonce(intent)).resolves.toMatch(/^wln_/);
  });

  test("beginLaunchAttempt opens one attempt per snapshot, and a failure for an older one is refused", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(await store.beginLaunchAttempt(intent, 0)).toBe(1);
    // A second pass that read the same snapshot does not open another.
    expect(await store.beginLaunchAttempt(intent, 0)).toBeNull();
    // Only the attempt just opened is issued a credential.
    await expect(store.issueBootstrapNonce(intent, 0)).rejects.toThrow(
      "past this attempt",
    );
    await store.issueBootstrapNonce(intent, 1);
    // The failure of the attempt before this one is refused, and the
    // credential this attempt's resource holds survives it.
    expect(
      await store.recordLaunchFailure(intent, { ...FAILURE, expectedCount: 0 }),
    ).toBe("stale");
    const [row] = await db
      .select({ nonceHash: workerLaunches.nonceHash })
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(row?.nonceHash).not.toBeNull();
    // Its own failure is counted, and moves the attempts on with it.
    expect(
      await store.recordLaunchFailure(intent, {
        ...FAILURE,
        expectedAttempts: 1,
        expectedCount: 0,
      }),
    ).toBe("backing_off");
    expect((await store.listActiveExecutions("local_docker"))[0]).toMatchObject(
      { launchAttempts: 2, launchFailureCount: 1 },
    );
    // A released launch opens nothing.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await store.beginLaunchAttempt(intent, 2)).toBeNull();
  });

  test("recordLaunchFailure leaves a claimed, killed or released launch alone", async () => {
    for (const moveOn of ["claim", "kill", "release"] as const) {
      const sessionId = await insertUnassigned();
      const intent = await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        sessionId,
        slotLimit: 10,
      });
      if (!intent) throw new Error("no intent");
      if (moveOn === "claim") {
        await db.insert(attempts).values({
          id: `att-${intent.executionId}`,
          sessionId,
          executionId: intent.executionId,
          leaseEpoch: 1,
          executionGeneration: 1,
          authRevision: 0,
          state: "running",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        });
        await db
          .update(workerLaunches)
          .set({ claimedAttemptId: `att-${intent.executionId}` })
          .where(eq(workerLaunches.executionId, intent.executionId));
      } else if (moveOn === "kill") {
        await db
          .update(executions)
          .set({ desiredState: "terminated" })
          .where(eq(executions.id, intent.executionId));
      } else {
        await store.confirmExecutionGone(intent.executionId, NOW, null);
      }
      expect(
        await store.recordLaunchFailure(intent, {
          ...FAILURE,
          expectedCount: 0,
          quarantine: true,
        }),
      ).toBe("stale");
      const [row] = await db
        .select({ count: workerLaunches.launchFailureCount })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, intent.executionId));
      expect(row?.count).toBe(0);
    }
  });

  test("a quarantine fails the queued input, drops the signal, and writes the kill", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const first = await queueInput(sessionId, 1);
    const second = await queueInput(sessionId, 2);
    await db
      .update(workerLaunches)
      .set({ launchFailureCount: 4, replacementReason: "stale_isolation" })
      .where(eq(workerLaunches.executionId, intent.executionId));

    expect(
      await store.recordLaunchFailure(intent, {
        ...FAILURE,
        expectedCount: 4,
        quarantine: true,
      }),
    ).toBe("quarantined");

    const [launch] = await db
      .select()
      .from(workerLaunches)
      .where(eq(workerLaunches.executionId, intent.executionId));
    expect(launch?.launchFailureCount).toBe(5);
    expect(launch?.launchRetryAt).toBeNull();
    expect(launch?.replacementReason).toBeNull();
    // The slot is still held: it comes back when the kill is confirmed.
    expect(launch?.slotReleasedAt).toBeNull();
    expect(await store.desiredStateOf(intent)).toBe("terminated");

    const failed = await db
      .select({ status: turns.status, reason: turns.terminalReason })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    expect(failed).toEqual([
      { status: "failed", reason: "launch_failed" },
      { status: "failed", reason: "launch_failed" },
    ]);
    expect(
      await db
        .select()
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, sessionId)),
    ).toEqual([]);
    for (const { receiptId } of [first, second]) {
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId));
      expect(receipt?.status).toBe("failed");
      expect(receipt?.error).toMatchObject({ code: "LAUNCH_FAILED" });
      expect(receipt?.result).toEqual({
        turn_id: receipt?.operation === "create_session" ? "1" : "2",
        receipt_status: "accepted",
      });
    }
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toEqual([]);
    const [session] = await db
      .select({ admission: sessions.admissionState, status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toEqual({ admission: "active", status: "failed" });
    const [event] = await db
      .select({ payload: events.payload, type: events.type })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    expect(event).toMatchObject({
      type: "status",
      payload: { phase: "failed", code: "LAUNCH_FAILED", failed_turn_count: 2 },
    });

    // The kill is confirmed like any other: the slot comes back and nothing
    // is signalled, since nothing is queued.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(
      (await store.inspectDemand({ limit: 10 })).activeExecutionCount,
    ).toBe(0);
    expect(
      (await store.inspectDemand({ limit: 10 })).eligibleSessionIds,
    ).toEqual([]);
  });

  test("settling a replacement leaves one asked for since alone", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(await store.requestReplacement(intent, "stale_isolation", 0)).toBe(
      1,
    );
    // Another pass judged the rebuild and asked again before this one
    // settled the first.
    expect(await store.requestReplacement(intent, "nonce_expired", 1)).toBe(2);
    await store.settleReplacement(intent, 1);
    const reasonNow = async () =>
      (
        await db
          .select({ reason: workerLaunches.replacementReason })
          .from(workerLaunches)
          .where(eq(workerLaunches.executionId, intent.executionId))
      )[0]?.reason;
    expect(await reasonNow()).toBe("nonce_expired");
    await store.settleReplacement(intent, 2);
    expect(await reasonNow()).toBeNull();
  });

  test("a pending replacement defers an exit confirmation and says so", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(await store.requestReplacement(intent, "stale_isolation", 0)).toBe(
      1,
    );
    expect(
      await store.confirmExecutionGone(intent.executionId, NOW, null),
    ).toBe("deferred");
    expect(await store.listActiveExecutions("local_docker")).toHaveLength(1);
  });

  test("confirmExecutionGone without an incarnation speaks for whatever the launch runs", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    await store.issueBootstrapNonce(intent);
    await store.issueBootstrapNonce(intent);
    expect(
      await store.confirmExecutionGone(intent.executionId, NOW, null),
    ).toBe("confirmed");
    expect(await store.listActiveExecutions("local_docker")).toEqual([]);
  });

  test("reserveLaunch stores the pinned image and limits with the launch, and refuses limits nothing could launch", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    expect(intent).toMatchObject(SPEC);
    const [row] = await db.select().from(workerLaunches);
    expect(row?.image).toBe(SPEC.image);
    expect(row?.resources).toEqual(SPEC.resources);
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active).toMatchObject(SPEC);

    const other = await insertUnassigned();
    await expect(
      store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: NOW,
        resources: { ...SPEC.resources, memoryBytes: 0 },
        sessionId: other,
        slotLimit: 10,
      }),
    ).rejects.toThrow("memoryBytes 0 is not a positive integer");
    expect(await db.select().from(workerLaunches)).toHaveLength(1);
  });

  test("a launch holds both halves of its spec or neither, and a stored spec that is not one fails loudly", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const failure = await db
      .update(workerLaunches)
      .set({ resources: null })
      .where(eq(workerLaunches.executionId, intent.executionId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String((failure as Error).cause)).toMatch(
      /worker_launches_launch_spec_check/,
    );

    await db
      .update(workerLaunches)
      .set({ resources: { cpus: 1 } })
      .where(eq(workerLaunches.executionId, intent.executionId));
    await expect(store.listActiveExecutions("local_docker")).rejects.toThrow(
      "memoryBytes undefined is not a positive integer",
    );
  });

  test("a spec mismatch is a replacement reason like the others", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    const nonce = await store.issueBootstrapNonce(intent);
    expect(
      await store.requestReplacement(
        intent,
        "spec_mismatch",
        0,
        launchNonceFingerprint(sha256(nonce)),
      ),
    ).toBe(1);
    const [active] = await store.listActiveExecutions("local_docker");
    expect(active?.pendingReplacement).toBe("spec_mismatch");
  });

  test("the schema refuses a replacement reason it does not know", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    // Drizzle wraps the driver error; the constraint is named in its cause.
    const failure = await db
      .update(workerLaunches)
      .set({ replacementReason: "because" })
      .where(eq(workerLaunches.executionId, intent.executionId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toMatch(
      /worker_launches_replacement_reason_check/,
    );
  });

  test("acquirePassLock hands out the lock once and releases it", async () => {
    const lock = await store.acquirePassLock();
    expect(lock).not.toBeNull();
    expect(lock?.signal.aborted).toBe(false);
    // PGlite is one session, so the same session re-acquires; the real
    // Postgres race is covered in scheduler-store.integration.test.ts.
    await lock?.release();
    expect(await store.acquirePassLock()).not.toBeNull();
  });

  test("filterKnown keeps refs whose row exists with the same generation", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("no intent");
    expect(
      await store.filterKnown(
        [
          intent,
          { executionId: intent.executionId, generation: 2 },
          { executionId: "exec-ghost", generation: 1 },
        ],
        "local_docker",
      ),
    ).toEqual([intent]);
    expect(await store.filterKnown([], "local_docker")).toEqual([]);

    // A launch that gave its slot back no longer owns its resource.
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await store.filterKnown([intent], "local_docker")).toEqual([]);
  });
  test("workspaces are retained until the session is finished with them", async () => {
    const active = await insertUnassigned();
    const paused = await insertUnassigned({ admissionState: "paused" });
    const recovery = await insertUnassigned({
      admissionState: "recovery_required",
    });
    const stopped = await insertUnassigned({ admissionState: "stopped" });
    const closed = await insertUnassigned({ admissionState: "closed" });
    const gone = crypto.randomUUID();

    const retained = await store.filterRetainedSessions(
      [active, paused, recovery, stopped, closed, gone],
      DAY,
    );

    // Everything but `closed` is resumed into the same working tree, so the
    // workspace has to outlive the container. `stopped` is the one that looks
    // terminal and is not: resume takes only an expected revision, so it comes
    // back on the same session id and the same volume name.
    expect(new Set(retained)).toEqual(
      new Set([active, paused, recovery, stopped]),
    );
  });

  test("a finished session still holding a live execution keeps its workspace", async () => {
    // Close is recorded before the container is torn down; reclaiming the
    // volume in that window would pull it out from under a running worker.
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, sessionId));

    expect(await store.filterRetainedSessions([sessionId], DAY)).toEqual([
      sessionId,
    ]);

    await store.recordObservation(intent, {
      found: false,
      observedAt: NOW,
      providerRef: null,
      state: "terminated",
    });
    // Seeing it terminated is not the release: the launch keeps its slot, and
    // the session with it, until the pass confirms the resource is gone.
    expect(await store.filterRetainedSessions([sessionId], DAY)).toEqual([
      sessionId,
    ]);

    await store.confirmExecutionGone(intent.executionId, NOW, null);
    expect(await store.filterRetainedSessions([sessionId], DAY)).toEqual([]);
  });

  test("a stopped session keeps its workspace for its TTL once its container is gone", async () => {
    // The regression this guards: `stopped` reads as terminal but is the
    // state an explicit resume comes back from, into this very volume.
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    await db
      .update(sessions)
      .set({ admissionState: "stopped" })
      .where(eq(sessions.id, sessionId));
    await store.recordObservation(intent, {
      found: false,
      observedAt: NOW,
      providerRef: null,
      state: "terminated",
    });
    await store.confirmExecutionGone(intent.executionId, new Date(), null);

    expect(await store.filterRetainedSessions([sessionId], DAY)).toEqual([
      sessionId,
    ]);
  });

  test("a legacy workspace goes only for a session the database proves closed", async () => {
    const active = await insertUnassigned();
    const stopped = await insertUnassigned({ admissionState: "stopped" });
    const closed = await insertUnassigned({ admissionState: "closed" });
    // A name that parses as a session id but has no row is not evidence: the
    // volume may be anyone's.
    const unknown = crypto.randomUUID();

    expect(
      await store.filterClosedLegacySessions([
        active,
        stopped,
        closed,
        unknown,
        "not-a-session",
      ]),
    ).toEqual([closed]);
  });

  test("a closed session whose launch still holds its slot keeps its legacy workspace", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, sessionId));

    expect(await store.filterClosedLegacySessions([sessionId])).toEqual([]);

    await store.confirmExecutionGone(intent.executionId, new Date(), null);
    expect(await store.filterClosedLegacySessions([sessionId])).toEqual([
      sessionId,
    ]);
  });

  test("an id that is not a session id is retained rather than judged", async () => {
    // A volume labelled with something else is not ours to reason about, and
    // binding it to a uuid column would throw and take the whole GC step down.
    expect(await store.filterRetainedSessions(["not-a-uuid"], DAY)).toEqual([
      "not-a-uuid",
    ]);
    expect(await store.filterRetainedSessions([], DAY)).toEqual([]);
  });
  test("a stopped session is kept for its TTL and is a candidate after it", async () => {
    const recent = await insertUnassigned({ admissionState: "stopped" });
    const old = await insertUnassigned({
      admissionState: "stopped",
      updatedAt: new Date(Date.now() - DAY_MS - 60_000),
    });
    const oldPaused = await insertUnassigned({
      admissionState: "paused",
      updatedAt: new Date(Date.now() - DAY_MS - 60_000),
    });

    // Only `stopped` expires: a paused session resumes through its own path.
    expect(
      new Set(
        await store.filterRetainedSessions([recent, old, oldPaused], DAY),
      ),
    ).toEqual(new Set([recent, oldPaused]));
    // A zero TTL makes every stopped session a candidate at once.
    expect(
      await store.filterRetainedSessions([recent], { stoppedTtlMs: 0 }),
    ).toEqual([]);
  });

  test("a claim is needed only where a resume could still come back", async () => {
    const closed = await insertUnassigned({ admissionState: "closed" });
    const input = { stoppedTtlMs: DAY_MS, workspaceId: "ap-ws-x" };

    expect(
      await store.claimWorkspaceReclaim({ ...input, sessionId: closed }),
    ).toEqual({ kind: "unclaimed" });
    expect(
      await store.claimWorkspaceReclaim({
        ...input,
        sessionId: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "unclaimed" });
    expect(
      await store.claimWorkspaceReclaim({ ...input, sessionId: "not-a-uuid" }),
    ).toEqual({ kind: "retained" });
  });

  test("an expired stopped session is claimed once, and nothing else is", async () => {
    const stoppedAt = new Date(Date.now() - DAY_MS - 60_000);
    const active = await insertUnassigned({ updatedAt: stoppedAt });
    const recent = await insertUnassigned({ admissionState: "stopped" });
    const old = await insertUnassigned({
      admissionState: "stopped",
      updatedAt: stoppedAt,
    });
    const claim = (sessionId: string) =>
      store.claimWorkspaceReclaim({
        sessionId,
        stoppedTtlMs: DAY_MS,
        workspaceId: `ap-ws-${sessionId}`,
      });

    expect(await claim(active)).toEqual({ kind: "retained" });
    expect(await claim(recent)).toEqual({ kind: "retained" });
    const claimed = await claim(old);
    if (claimed.kind !== "claimed") throw new Error("not claimed");
    // One at a time: the pending claim is settled by the sweep, not doubled.
    expect(await claim(old)).toEqual({ kind: "retained" });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, old));
    expect(row?.workspaceReclaimId).toBe(claimed.claimId);
    expect(row?.workspaceReclaimWorkspaceId).toBe(`ap-ws-${old}`);
    expect(row?.workspaceReclaimClaimedAt).not.toBeNull();
    // The stop's clock is what the TTL reads; claiming must not move it.
    expect(row?.updatedAt).toEqual(stoppedAt);
    expect(await store.listPendingWorkspaceReclaims()).toEqual([
      {
        claimId: claimed.claimId,
        sessionId: old,
        workspaceId: `ap-ws-${old}`,
      },
    ]);
  });

  test("a stopped session whose launch still holds its slot is not claimed", async () => {
    const sessionId = await insertUnassigned();
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    await db
      .update(sessions)
      .set({
        admissionState: "stopped",
        updatedAt: new Date(Date.now() - DAY_MS - 60_000),
      })
      .where(eq(sessions.id, sessionId));
    const claim = () =>
      store.claimWorkspaceReclaim({
        sessionId,
        stoppedTtlMs: DAY_MS,
        workspaceId: "ap-ws-held",
      });

    expect(await store.filterRetainedSessions([sessionId], DAY)).toEqual([
      sessionId,
    ]);
    expect(await claim()).toEqual({ kind: "retained" });

    await store.recordObservation(intent, {
      found: false,
      observedAt: NOW,
      providerRef: null,
      state: "terminated",
    });
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    await db
      .update(sessions)
      .set({ updatedAt: new Date(Date.now() - DAY_MS - 60_000) })
      .where(eq(sessions.id, sessionId));

    expect((await claim()).kind).toBe("claimed");
  });

  const PAUSED_TTLS = { stoppedTtlMs: DAY_MS, pausedTtlMs: DAY_MS };

  /** Paused a day and a minute ago, with a checkpoint to resume from. */
  function expiredPaused(
    overrides: Partial<typeof sessions.$inferInsert> = {},
  ) {
    return insertUnassigned({
      admissionState: "paused",
      checkpointRevision: 2,
      pausedAt: new Date(Date.now() - DAY_MS - 60_000),
      ...overrides,
    });
  }

  test("a paused session with a checkpoint is a candidate once its TTL from the pause runs out", async () => {
    const old = await expiredPaused({ updatedAt: new Date() });
    const recent = await expiredPaused({ pausedAt: new Date() });
    const noPointer = await expiredPaused({ checkpointRevision: null });
    const noClock = await expiredPaused({ pausedAt: null });
    const ids = [old, recent, noPointer, noClock];

    // The pause's own clock is read, not `updated_at`.
    expect(
      new Set(await store.filterRetainedSessions(ids, PAUSED_TTLS)),
    ).toEqual(new Set([recent, noPointer, noClock]));
    // Without a paused TTL, no paused session is a candidate.
    expect(new Set(await store.filterRetainedSessions(ids, DAY))).toEqual(
      new Set(ids),
    );
  });

  test("a paused session is claimed only with a checkpoint its resume would restore", async () => {
    const claim = (sessionId: string, ttls: typeof DAY = PAUSED_TTLS) =>
      store.claimWorkspaceReclaim({
        sessionId,
        workspaceId: `ap-ws-${sessionId}`,
        ...ttls,
      });
    const pausedAt = new Date(Date.now() - DAY_MS - 60_000);
    const old = await expiredPaused({ pausedAt });

    expect(await claim(await expiredPaused({ pausedAt: new Date() }))).toEqual({
      kind: "retained",
    });
    expect(await claim(await expiredPaused({ pausedAt: null }))).toEqual({
      kind: "retained",
    });
    expect(
      await claim(await expiredPaused({ checkpointRevision: null })),
    ).toEqual({ kind: "retained" });
    // Retired by start_fresh: a resume would refuse it.
    expect(
      await claim(await expiredPaused({ contextResetCheckpointRevision: 2 })),
    ).toEqual({ kind: "retained" });
    expect(await claim(await expiredPaused({ podId: "legacy-pod" }))).toEqual({
      kind: "retained",
    });
    expect(
      await claim(
        await expiredPaused({ admissionState: "pausing", pausedAt: null }),
      ),
    ).toEqual({ kind: "retained" });
    expect(await claim(old, DAY)).toEqual({ kind: "retained" });

    const claimed = await claim(old);
    if (claimed.kind !== "claimed") throw new Error("not claimed");
    const [row] = await db.select().from(sessions).where(eq(sessions.id, old));
    expect(row?.workspaceReclaimId).toBe(claimed.claimId);
    // The pause's clock is what the TTL reads; claiming must not move it.
    expect(row?.pausedAt).toEqual(pausedAt);
  });

  test("paused_at is stamped by entering paused, kept by other writes and cleared by leaving", async () => {
    const sessionId = await insertUnassigned();
    const row = async () => {
      const [found] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      if (!found) throw new Error("no session");
      return found;
    };
    const set = (values: Partial<typeof sessions.$inferInsert>) =>
      db.update(sessions).set(values).where(eq(sessions.id, sessionId));

    expect((await row()).pausedAt).toBeNull();
    await set({ admissionState: "pausing" });
    expect((await row()).pausedAt).toBeNull();
    const before = Date.now();
    await set({ admissionState: "paused" });
    const paused = (await row()).pausedAt;
    if (paused === null) throw new Error("paused_at not stamped");
    expect(paused.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // A later write to the row, even one carrying an older clock, keeps it.
    await set({ title: "renamed", updatedAt: new Date(0) });
    expect((await row()).pausedAt).toEqual(paused);

    await set({ admissionState: "resuming" });
    expect((await row()).pausedAt).toBeNull();
  });

  test("a paused session whose launch still holds its slot is not claimed", async () => {
    const sessionId = await insertUnassigned({ checkpointRevision: 2 });
    const intent = await store.reserveLaunch({
      ...SPEC,
      backend: "local_docker",
      now: NOW,
      sessionId,
      slotLimit: 10,
    });
    if (!intent) throw new Error("reservation refused");
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, sessionId));
    const backdate = () =>
      db
        .update(sessions)
        .set({ pausedAt: new Date(Date.now() - DAY_MS - 60_000) })
        .where(eq(sessions.id, sessionId));
    await backdate();
    const claim = () =>
      store.claimWorkspaceReclaim({
        sessionId,
        workspaceId: "ap-ws-held",
        ...PAUSED_TTLS,
      });

    expect(
      await store.filterRetainedSessions([sessionId], PAUSED_TTLS),
    ).toEqual([sessionId]);
    expect(await claim()).toEqual({ kind: "retained" });

    await store.recordObservation(intent, {
      found: false,
      observedAt: NOW,
      providerRef: null,
      state: "terminated",
    });
    await store.confirmExecutionGone(intent.executionId, NOW, null);
    await backdate();

    expect((await claim()).kind).toBe("claimed");
  });

  test("a claim is settled only by its own id", async () => {
    const stoppedAt = new Date(Date.now() - DAY_MS - 60_000);
    const removed = await insertUnassigned({
      admissionState: "stopped",
      updatedAt: stoppedAt,
    });
    const released = await insertUnassigned({
      admissionState: "stopped",
      updatedAt: stoppedAt,
    });
    const claimOf = async (sessionId: string) => {
      const result = await store.claimWorkspaceReclaim({
        sessionId,
        stoppedTtlMs: DAY_MS,
        workspaceId: "ap-ws-y",
      });
      if (result.kind !== "claimed") throw new Error("not claimed");
      return result.claimId;
    };
    const removedClaim = await claimOf(removed);
    const releasedClaim = await claimOf(released);
    const rowOf = async (sessionId: string) =>
      (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];

    await store.finishWorkspaceReclaim({
      claimId: crypto.randomUUID(),
      outcome: "removed",
      sessionId: removed,
    });
    expect((await rowOf(removed))?.workspaceReclaimId).toBe(removedClaim);

    await store.finishWorkspaceReclaim({
      claimId: removedClaim,
      outcome: "removed",
      sessionId: removed,
    });
    await store.finishWorkspaceReclaim({
      claimId: releasedClaim,
      outcome: "released",
      sessionId: released,
    });

    const afterRemoved = await rowOf(removed);
    expect(afterRemoved?.workspaceReclaimId).toBeNull();
    expect(afterRemoved?.workspaceReclaimWorkspaceId).toBeNull();
    expect(afterRemoved?.workspaceReclaimedAt).not.toBeNull();
    expect(afterRemoved?.updatedAt).toEqual(stoppedAt);
    const afterReleased = await rowOf(released);
    expect(afterReleased?.workspaceReclaimId).toBeNull();
    expect(afterReleased?.workspaceReclaimedAt).toBeNull();
    expect(await store.listPendingWorkspaceReclaims()).toEqual([]);
  });
});

function sha256(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}
