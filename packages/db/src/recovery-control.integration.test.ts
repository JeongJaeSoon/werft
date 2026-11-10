import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type RecoveryDecisionRequest,
  sessionEventVariants,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type WorkerGateway,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { forgetLostCheckpoints } from "./checkpoint-store.ts";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  checkpoints,
  events,
  executions,
  pendingRequests,
  queueMessages,
  receipts,
  sessionPinCutover,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };

integration("recovery decisions and resume from stopped on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  const clock = new Date("2026-09-23T00:00:00.000Z");
  const now = () => clock;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "recovery_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: withSeededInstallation({
        profiles: {
          "claude-coding-v1": {
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Bash"],
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
      // Only a refused preparation is ever sent here, which is answered
      // before the protocol is consulted.
      checkpointProtocol: {
        async requestCheckpoint() {
          throw new Error("no checkpoint store in these tests");
        },
        async getRestorePlan() {
          throw new Error("no checkpoint store in these tests");
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 2_000,
        now,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const controls = () => createPostgresSessionControl(db);
  const inputs = () => createPostgresSessionUnitOfWork(db);
  const store = () =>
    createPostgresSchedulerStore(db, {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      connectForLock: () => pool.connect(),
    });

  type Session = { session_id: string; ownerId: string };

  async function queuedSession(partition: string): Promise<Session> {
    const ownerId = `owner-${crypto.randomUUID()}`;
    const result = await inputs().acceptInputAtomic({
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
    return { session_id: result.response.session_id, ownerId };
  }

  async function launch(partition: string, sessionId: string) {
    return { ...(await launchSession(db, { sessionId })), partition };
  }

  function claim(l: Awaited<ReturnType<typeof launch>>) {
    return gateway.bootstrapClaim(bootstrap, {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    });
  }

  function scopeOf(claimed: Awaited<ReturnType<typeof claim>>): WorkerScope {
    return {
      session_id: claimed.session_id,
      turn_id: null,
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

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function receiptRow(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    if (!row) throw new Error("receipt vanished");
    return row;
  }

  async function turnRows(sessionId: string) {
    return db
      .select({
        sequence: turns.sequence,
        status: turns.status,
        terminalReason: turns.terminalReason,
        outcomeUnknown: turns.outcomeUnknown,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(asc(turns.sequence));
  }

  async function queueRows(sessionId: string) {
    return db
      .select({ turnId: queueMessages.turnId })
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId));
  }

  async function append(session: Session, message: string) {
    const appended = await inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message,
    });
    if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    return appended.response;
  }

  function decide(
    session: Session,
    decision: RecoveryDecisionRequest,
    overrides: { idempotencyKey?: string; payloadHash?: string } = {},
  ) {
    return controls().decideRecoveryAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
      payloadHash: overrides.payloadHash ?? crypto.randomUUID(),
      decision,
      now: clock,
    });
  }

  function resume(
    session: Session,
    expectedRevision: number,
    overrides: { idempotencyKey?: string; payloadHash?: string } = {},
  ) {
    return controls().resumeAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
      payloadHash: overrides.payloadHash ?? crypto.randomUUID(),
      expectedRevision,
      now: clock,
    });
  }

  async function terminate(session: Session) {
    const before = await sessionRow(session.session_id);
    const result = await controls().terminateAtomic({
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      expectedRevision: before.revision,
      reason: "operator",
      now: clock,
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return result.response;
  }

  // The status events a client reads from GET /v1/sessions/{id}/events.
  async function statusFrames(session: Session) {
    const page = await createPostgresSessionReader(db).readEvents(
      session.ownerId,
      session.session_id,
      { limit: 100, maxBytes: 1 << 20 },
    );
    if (!page) throw new Error("session not readable");
    return page.items.flatMap((frame) =>
      frame.event === "status"
        ? [sessionEventVariants.status.shape.data.parse(frame.data.data)]
        : [],
    );
  }

  // What GET /v1/sessions/{id} says, in the shape of a status event.
  async function readsAs(session: Session) {
    const detail = await createPostgresSessionReader(db).getSession(
      session.ownerId,
      session.session_id,
    );
    return { phase: detail?.status, admission_state: detail?.admission_state };
  }

  /**
   * A session whose turn 1 was delivered to a worker that then vanished
   * without a terminate (crash, lease loss): turn 1 outcome_unknown,
   * admission recovery_required, execution gone. A second input is queued
   * behind it when `queuedBehind` is set; a terminate would have cancelled
   * it, which is why the exit is observed directly here.
   */
  async function unknownSession(
    name: string,
    options: {
      queuedBehind?: boolean;
      checkpointRevision?: number;
      // Whether that checkpoint was taken at turn 1 (so it covers the
      // unknown turn) or before it.
      checkpointCoversTurn1?: boolean;
    } = {},
  ) {
    const partition = `${name}-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    const next = await gateway.nextInput(
      principalOf(claimed),
      scopeOf(claimed),
    );
    if (!next.input) throw new Error("no input delivered");
    const behind = options.queuedBehind
      ? await append(session, "second input")
      : null;
    if (options.checkpointRevision !== undefined) {
      const [turn1] = await db
        .select({ id: turns.id })
        .from(turns)
        .where(
          and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 1)),
        );
      await db.insert(checkpoints).values({
        sessionId: session.session_id,
        revision: options.checkpointRevision,
        manifestRef: `manifests/${session.session_id}/${options.checkpointRevision}`,
        manifestSha256: "0".repeat(64),
        turnId: options.checkpointCoversTurn1 ? (turn1?.id ?? null) : null,
      });
      await db
        .update(sessions)
        .set({
          checkpointRevision: options.checkpointRevision,
          checkpointCommittedAt: clock,
        })
        .where(eq(sessions.id, session.session_id));
    }
    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    expect(row.executionId).toBeNull();
    return { session, launch: l, claimed, behind, row };
  }

  test("a checkpoint forgetLostCheckpoints gave up restores nothing: abandon then resume refuses, start_fresh goes on", async () => {
    const { session } = await unknownSession("lost-checkpoint", {
      checkpointRevision: 2,
      checkpointCoversTurn1: true,
    });
    expect(await forgetLostCheckpoints(db, clock)).toEqual({
      held: [session.session_id],
      unchanged: [],
    });
    const held = await sessionRow(session.session_id);
    expect(held).toMatchObject({
      admissionState: "recovery_required",
      checkpointRevision: 2,
      contextResetCheckpointRevision: 2,
      contextResetTurnSequence: null,
    });

    const abandoned = await decide(session, {
      decision: "abandon",
      expected_revision: held.revision,
      target_turn_id: "1",
      reason: "lost with its checkpoint",
    });
    if (abandoned.outcome !== "accepted") throw new Error(abandoned.outcome);
    const stopped = await sessionRow(session.session_id);
    expect(stopped.admissionState).toBe("stopped");
    // Covered by the lost checkpoint, so before it was retired this resume
    // was accepted and its worker restored objects that are gone.
    expect(await resume(session, stopped.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    const fresh = await decide(session, {
      decision: "start_fresh",
      expected_revision: stopped.revision,
      reason: "go on without the lost context",
    });
    if (fresh.outcome !== "accepted") throw new Error(fresh.outcome);
    expect(await sessionRow(session.session_id)).toMatchObject({
      admissionState: "active",
      contextResetCheckpointRevision: 2,
    });
  });

  test("abandon: turn cancelled(operator_abandoned), queue head released, stopped, audit; queued input kept, nothing dispatched", async () => {
    const { session, behind, row } = await unknownSession("abandon", {
      queuedBehind: true,
      checkpointRevision: 2,
    });
    expect(await queueRows(session.session_id)).toHaveLength(2);

    const result = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "worker lost mid-turn, side effects reviewed",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("succeeded");

    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("stopped");
    expect(after.status).toBe("stopped");
    expect(after.revision).toBe(row.revision + 1);
    expect(await turnRows(session.session_id)).toEqual([
      {
        sequence: 1,
        status: "cancelled",
        terminalReason: "operator_abandoned",
        // The execution's effects are still unknown; abandon does not
        // claim otherwise.
        outcomeUnknown: true,
      },
      {
        sequence: 2,
        status: "queued",
        terminalReason: null,
        outcomeUnknown: false,
      },
    ]);
    // Head released, the queued input behind it is untouched.
    const queue = await queueRows(session.session_id);
    expect(queue).toHaveLength(1);
    const [second] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(eq(turns.sessionId, session.session_id), eq(turns.sequence, 2)),
      );
    expect(queue[0]?.turnId).toBe(second?.id ?? -1);
    // The abandoned input's receipt fails; the queued one is still accepted.
    const [inputReceipt] = await db
      .select({ status: receipts.status, error: receipts.error })
      .from(receipts)
      .where(
        and(
          eq(receipts.operation, "create_session"),
          eq(receipts.ownerId, session.ownerId),
        ),
      );
    expect(inputReceipt).toMatchObject({
      status: "failed",
      error: { code: "SESSION_STOPPED" },
    });
    expect((await receiptRow(behind?.receipt_id ?? "")).status).toBe(
      "accepted",
    );
    const receipt = await receiptRow(result.response.receipt_id);
    expect(receipt.operation).toBe("recovery_decision");
    expect(receipt.targetRef).toEqual({
      session_id: session.session_id,
      turn_id: "1",
      request_id: null,
    });
    expect(receipt.result).toEqual({
      resulting_admission_state: "stopped",
      checkpoint_revision: 2,
      resumable: true,
    });
    const audit = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, session.session_id),
          eq(events.type, "system"),
        ),
      );
    expect(audit).toEqual([
      {
        type: "system",
        payload: expect.objectContaining({
          type: "system",
          subtype: "recovery_decision",
          decision: "abandon",
          target_turn_id: "1",
          evidence_ref: null,
          reason: "worker lost mid-turn, side effects reviewed",
          actor: { owner_id: session.ownerId },
          resulting_admission_state: "stopped",
          resumable: true,
        }),
      },
    ]);
    // No automatic dispatch: the scheduler sees nothing to launch.
    const signalled = await db
      .select({ sessionId: unassignedSessions.sessionId })
      .from(unassignedSessions)
      .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
      .where(
        and(
          eq(unassignedSessions.sessionId, session.session_id),
          eq(sessions.admissionState, "active"),
        ),
      );
    expect(signalled).toEqual([]);
  });

  test.each([
    {
      decision: "abandon",
      reason: "side effects reviewed",
      admission: "stopped",
    },
    {
      decision: "confirm_completed",
      reason: "verified by hand",
      admission: "stopped",
    },
    { decision: "close", reason: "give up", admission: "closed" },
  ] as const)(
    "$decision puts the admission it reaches on the stream, in step with GET",
    async ({ decision, reason, admission }) => {
      const { session, row } = await unknownSession(`stream-${decision}`, {
        checkpointRevision: 3,
        checkpointCoversTurn1: true,
      });
      const before = await statusFrames(session);
      expect(before.at(-1)).toEqual({
        phase: "failed",
        admission_state: "recovery_required",
      });
      const result = await decide(
        session,
        decision === "close"
          ? { decision, expected_revision: row.revision, reason }
          : decision === "confirm_completed"
            ? {
                decision,
                expected_revision: row.revision,
                target_turn_id: "1",
                evidence_ref: "s3://audit/verified.json",
                reason,
              }
            : {
                decision,
                expected_revision: row.revision,
                target_turn_id: "1",
                reason,
              },
      );
      if (result.outcome !== "accepted") throw new Error(result.outcome);
      const after = await statusFrames(session);
      expect(after.slice(before.length)).toEqual([
        {
          phase: "stopped",
          admission_state: admission,
          decision,
          actor: { owner_id: session.ownerId },
        },
      ]);
      expect(after.at(-1)).toMatchObject(await readsAs(session));
    },
  );

  test("abandon without any checkpoint: stopped but resumable=false, and resume is CHECKPOINT_UNAVAILABLE", async () => {
    const { session, row } = await unknownSession("nocp");
    const result = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "nothing to keep",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      resulting_admission_state: "stopped",
      checkpoint_revision: null,
      resumable: false,
    });
    const after = await sessionRow(session.session_id);
    expect(await resume(session, after.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "stopped",
    );
  });

  test("confirm_completed: turn completed with the evidence, input receipt succeeded, queue head released, stopped", async () => {
    const { session, row } = await unknownSession("confirm", {
      checkpointRevision: 5,
      checkpointCoversTurn1: true,
    });
    const result = await decide(session, {
      decision: "confirm_completed",
      expected_revision: row.revision,
      target_turn_id: "1",
      evidence_ref: "s3://audit/session/turn-1/verified.json",
      reason: "commit and checkpoint verified by hand",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(await turnRows(session.session_id)).toEqual([
      {
        sequence: 1,
        status: "completed",
        terminalReason: "operator_confirmed",
        outcomeUnknown: false,
      },
    ]);
    const [turn] = await db
      .select({ resultJson: turns.resultJson })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.resultJson).toEqual({
      operator_decision: {
        decision: "confirm_completed",
        evidence_ref: "s3://audit/session/turn-1/verified.json",
        reason: "commit and checkpoint verified by hand",
      },
    });
    expect(await queueRows(session.session_id)).toEqual([]);
    const [inputReceipt] = await db
      .select({
        status: receipts.status,
        error: receipts.error,
        result: receipts.result,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.operation, "create_session"),
          eq(receipts.ownerId, session.ownerId),
        ),
      );
    // Succeeded, error cleared, and the acceptance response kept for the
    // idempotent retry of the original create.
    expect(inputReceipt).toMatchObject({
      status: "succeeded",
      error: null,
      result: { session_id: session.session_id, turn_id: "1" },
    });
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("stopped");
    // The pointer is whatever finalize committed; a decision never moves it.
    expect(after.checkpointRevision).toBe(5);
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      resulting_admission_state: "stopped",
      checkpoint_revision: 5,
      resumable: true,
    });
    const [audit] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.sessionId, session.session_id),
          eq(events.type, "system"),
        ),
      );
    expect(audit?.payload).toMatchObject({
      decision: "confirm_completed",
      evidence_ref: "s3://audit/session/turn-1/verified.json",
    });
  });

  test("confirm_completed is refused when the committed checkpoint predates the turn or is missing", async () => {
    const stale = await unknownSession("stale-cp", { checkpointRevision: 4 });
    const none = await unknownSession("no-cp");
    for (const { session, row } of [stale, none]) {
      expect(
        await decide(session, {
          decision: "confirm_completed",
          expected_revision: row.revision,
          target_turn_id: "1",
          evidence_ref: "s3://audit/turn-1",
          reason: "work was done outside",
        }),
      ).toEqual({ outcome: "checkpoint_not_covering" });
      // Nothing moved: still waiting for a decision, turn still unknown.
      const after = await sessionRow(session.session_id);
      expect(after.revision).toBe(row.revision);
      expect(after.admissionState).toBe("recovery_required");
      expect((await turnRows(session.session_id))[0]?.status).toBe(
        "outcome_unknown",
      );
    }
    // abandon stays available, and an older checkpoint still lets the
    // session resume without the abandoned turn.
    const abandoned = await decide(stale.session, {
      decision: "abandon",
      expected_revision: stale.row.revision,
      target_turn_id: "1",
      reason: "fall back to the older checkpoint",
    });
    expect(abandoned.outcome).toBe("accepted");
  });

  test("confirm_completed is judged on the revision a fallback restored, not on the damaged pointer", async () => {
    const { session, row } = await unknownSession("fallback-cp", {
      checkpointRevision: 5,
      checkpointCoversTurn1: true,
    });
    // An earlier revision taken before turn 1, which the last restore fell
    // back to because revision 5 was damaged.
    await db.insert(checkpoints).values({
      sessionId: session.session_id,
      revision: 4,
      manifestRef: `manifests/${session.session_id}/4`,
      manifestSha256: "0".repeat(64),
      turnId: null,
    });
    await db
      .update(sessions)
      .set({ checkpointFallbackRevision: 4 })
      .where(eq(sessions.id, session.session_id));
    const confirm = {
      decision: "confirm_completed",
      expected_revision: row.revision,
      target_turn_id: "1",
      evidence_ref: "s3://audit/turn-1",
      reason: "work was done outside",
    } as const;
    expect(await decide(session, confirm)).toEqual({
      outcome: "checkpoint_not_covering",
    });
    await db
      .update(sessions)
      .set({ checkpointFallbackRevision: null })
      .where(eq(sessions.id, session.session_id));
    expect((await decide(session, confirm)).outcome).toBe("accepted");
  });

  test("a durable checkpoint blocker leaves no restore point: confirm_completed refused, resume refused, close allowed", async () => {
    const { session, row, claimed } = await unknownSession("mirror-error", {
      checkpointRevision: 3,
      checkpointCoversTurn1: true,
    });
    // The run that took that checkpoint also dropped a transcript mirror
    // batch, so the pointer may be missing entries.
    await db
      .update(sessions)
      .set({
        checkpointPendingReason: "mirror_error",
        checkpointPendingAttemptId: claimed.attempt_id,
      })
      .where(eq(sessions.id, session.session_id));

    expect(
      await decide(session, {
        decision: "confirm_completed",
        expected_revision: row.revision,
        target_turn_id: "1",
        evidence_ref: "s3://audit/turn-1",
        reason: "work was done",
      }),
    ).toEqual({ outcome: "checkpoint_not_covering" });

    const abandoned = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    });
    if (abandoned.outcome !== "accepted") throw new Error(abandoned.outcome);
    expect((await receiptRow(abandoned.response.receipt_id)).result).toEqual({
      resulting_admission_state: "stopped",
      checkpoint_revision: 3,
      resumable: false,
    });

    // Resuming would leave an idle session whose appends stay refused while
    // the blocker stands; close is the way out.
    const stopped = await sessionRow(session.session_id);
    expect(await resume(session, stopped.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    const closed = await decide(session, {
      decision: "close",
      expected_revision: stopped.revision,
      reason: "untrusted checkpoint",
    });
    expect(closed.outcome).toBe("accepted");
    expect((await sessionRow(session.session_id)).admissionState).toBe(
      "closed",
    );
  });

  test("an advisory refusal keeps the pointer trusted, but a turn it left uncovered is a context gap: resume is refused and start_fresh continues", async () => {
    const partition = `advisory-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    const principal = principalOf(claimed);
    const scope = scopeOf(claimed);
    const finalize = (turnId: string, revision: number | null) =>
      gateway.finalize(principal, {
        ...scope,
        turn_id: turnId,
        finalize_key: `${scope.attempt_id}:${turnId}`,
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
                manifest_ref: `manifests/${session.session_id}/${revision}`,
                manifest_sha256: "0".repeat(64),
              },
      });

    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
    await finalize(first.input.turn_id, 0);

    // The next turn starts a dev server and ends with it still running: the
    // runtime refuses the checkpoint as not quiescent.
    await append(session, "start the dev server");
    const second = await gateway.nextInput(principal, scope);
    if (!second.input) throw new Error("no input delivered");
    expect(
      await gateway.requestCheckpoint(principal, {
        ...scope,
        turn_id: second.input.turn_id,
        preparation: {
          status: "rejected",
          reason: "background_writer",
          detail: "Background task(s) still running: bash_1",
        },
      }),
    ).toMatchObject({ status: "blocked", reason: "background_writer" });
    await finalize(second.input.turn_id, null);

    await terminate(session);
    await confirmExecutionGone(db, l.executionId);
    const stopped = await sessionRow(session.session_id);
    expect(stopped).toMatchObject({
      admissionState: "stopped",
      checkpointRevision: 0,
      checkpointPendingReason: "background_writer",
    });

    // The pointer is still trusted but covers turn 1 only
    // resuming from it would drop turn 2 without a word.
    expect(await resume(session, stopped.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    const fresh = await decide(session, {
      decision: "start_fresh",
      expected_revision: stopped.revision,
      reason: "turn 2 was not captured",
    });
    if (fresh.outcome !== "accepted") throw new Error(fresh.outcome);
    expect(fresh.response.receipt_status).toBe("succeeded");
    const after = await sessionRow(session.session_id);
    expect(after).toMatchObject({
      admissionState: "active",
      checkpointRevision: 0,
      contextResetCheckpointRevision: 0,
      contextResetTurnSequence: 2,
      checkpointPendingReason: null,
    });
    await append(session, "carry on");
  });

  test("once the spec pin is authoritative, a stopped session without a pin is not resumed and nothing about it changes", async () => {
    const partition = `pin-required-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    const principal = principalOf(claimed);
    const scope = scopeOf(claimed);
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
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
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${session.session_id}/0`,
        manifest_sha256: "0".repeat(64),
      },
    });
    await terminate(session);
    await confirmExecutionGone(db, l.executionId);
    const stopped = await sessionRow(session.session_id);
    expect(stopped.admissionState).toBe("stopped");

    // The flip is for good in production; this database gets the old rules
    // back afterwards.
    await db
      .update(sessionPinCutover)
      .set({ authoritative: true, flippedAt: new Date() });
    try {
      expect(await resume(session, stopped.revision)).toEqual({
        outcome: "pin_required",
      });
      expect(await sessionRow(session.session_id)).toEqual(stopped);
    } finally {
      await db
        .update(sessionPinCutover)
        .set({ authoritative: false, flippedAt: null });
    }
    // With the pin back to advisory the same request goes through.
    const resumed = await resume(session, stopped.revision);
    expect(resumed.outcome).toBe("accepted");
  });

  test("a stopped session whose uncaptured turn left no gap still resumes over an advisory reason", async () => {
    const partition = `advisory-covered-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    const principal = principalOf(claimed);
    const scope = scopeOf(claimed);
    const first = await gateway.nextInput(principal, scope);
    if (!first.input) throw new Error("no input delivered");
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
      checkpoint: {
        revision: 0,
        manifest_ref: `manifests/${session.session_id}/0`,
        manifest_sha256: "0".repeat(64),
      },
    });
    // A later capture of the same turn is refused as not quiescent: the
    // reason is recorded, but revision 0 already covers every turn.
    expect(
      await gateway.requestCheckpoint(principal, {
        ...scope,
        turn_id: first.input.turn_id,
        preparation: {
          status: "rejected",
          reason: "background_writer",
          detail: "Background task(s) still running: bash_1",
        },
      }),
    ).toMatchObject({ status: "blocked", reason: "background_writer" });

    await terminate(session);
    await confirmExecutionGone(db, l.executionId);
    const stopped = await sessionRow(session.session_id);
    expect(stopped).toMatchObject({
      admissionState: "stopped",
      checkpointRevision: 0,
      checkpointPendingReason: "background_writer",
    });
    // Resumable, so neither a recovery close's nor start_fresh's business.
    for (const decision of ["close", "start_fresh"] as const) {
      expect(
        await decide(session, {
          decision,
          expected_revision: stopped.revision,
          reason: "should be refused",
        }),
      ).toEqual({ outcome: "not_in_recovery", admissionState: "stopped" });
    }
    const resumed = await resume(session, stopped.revision);
    if (resumed.outcome !== "accepted") throw new Error(resumed.outcome);
    expect(await sessionRow(session.session_id)).toMatchObject({
      admissionState: "active",
      checkpointRevision: 0,
      // Only a later commit clears it, which the resumed run now can make.
      checkpointPendingReason: "background_writer",
    });
  });

  test.each([
    ["background_writer", true],
    ["tool_in_flight", true],
    ["checkpoint_lease_held", true],
    ["publish_failed", true],
    ["mirror_error", false],
    ["reason_from_a_newer_build", false],
  ])(
    "a stopped session with a pointer and %s pending is resumable=%p",
    async (reason, resumable) => {
      const { session, row } = await unknownSession(`reason-${reason}`, {
        checkpointRevision: 2,
        checkpointCoversTurn1: true,
      });
      await db
        .update(sessions)
        .set({ checkpointPendingReason: reason })
        .where(eq(sessions.id, session.session_id));

      const confirmed = await decide(session, {
        decision: "confirm_completed",
        expected_revision: row.revision,
        target_turn_id: "1",
        evidence_ref: "s3://audit/turn-1",
        reason: "verified",
      });
      if (!resumable) {
        expect(confirmed).toEqual({ outcome: "checkpoint_not_covering" });
        return;
      }
      if (confirmed.outcome !== "accepted") throw new Error(confirmed.outcome);
      expect((await receiptRow(confirmed.response.receipt_id)).result).toEqual({
        resulting_admission_state: "stopped",
        checkpoint_revision: 2,
        resumable: true,
      });
      const stopped = await sessionRow(session.session_id);
      expect((await resume(session, stopped.revision)).outcome).toBe(
        "accepted",
      );
    },
  );

  test("abandon and confirm_completed refuse a turn that is not unknown, a wrong revision and an unconfirmed exit", async () => {
    const { session, row } = await unknownSession("refuse", {
      queuedBehind: true,
    });
    expect(
      await decide(session, {
        decision: "abandon",
        expected_revision: row.revision,
        target_turn_id: "2",
        reason: "wrong turn",
      }),
    ).toEqual({ outcome: "turn_not_unknown", turnStatus: "queued" });
    expect(
      await decide(session, {
        decision: "abandon",
        expected_revision: row.revision,
        target_turn_id: "9",
        reason: "no such turn",
      }),
    ).toEqual({ outcome: "turn_not_unknown", turnStatus: null });
    // Non-canonical ids never alias turn 1, and nonsense never reaches SQL.
    for (const target of ["1e0", " 1", "01", "abc", "99999999999"]) {
      expect(
        await decide(session, {
          decision: "abandon",
          expected_revision: row.revision,
          target_turn_id: target,
          reason: "malformed id",
        }),
      ).toEqual({ outcome: "turn_not_unknown", turnStatus: null });
    }
    expect(
      await decide(session, {
        decision: "confirm_completed",
        expected_revision: row.revision + 1,
        target_turn_id: "1",
        evidence_ref: "ref",
        reason: "stale revision",
      }),
    ).toEqual({ outcome: "revision_conflict", currentRevision: row.revision });
    // Nothing above changed the row.
    expect((await sessionRow(session.session_id)).revision).toBe(row.revision);

    // An exit not yet confirmed: the session is still bound.
    const partition = `bound-${crypto.randomUUID()}`;
    const bound = await queuedSession(partition);
    const l = await launch(partition, bound.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    await terminate(bound);
    const stopping = await sessionRow(bound.session_id);
    expect(stopping.admissionState).toBe("stopping");
    expect(
      await decide(bound, {
        decision: "abandon",
        expected_revision: stopping.revision,
        target_turn_id: "1",
        reason: "too early",
      }),
    ).toEqual({ outcome: "execution_unconfirmed" });
  });

  test("close during a pending terminate: closed, queued cancelled, pending invalidated, kill outbox kept, terminate receipt CONTROL_SUPERSEDED", async () => {
    const partition = `close-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    const [running] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    await db.insert(pendingRequests).values({
      requestId: `req-${crypto.randomUUID()}`,
      sessionId: session.session_id,
      turnId: running?.id ?? -1,
      attemptId: claimed.attempt_id,
      kind: "permission",
      payload: {},
      inputHash: "h",
      expiresAt: new Date(clock.getTime() + 60_000),
    });
    const terminated = await terminate(session);
    expect(terminated.receipt_status).toBe("accepted");
    // terminate already cancelled anything queued; close on queued input is
    // covered by the recovery_required case below.
    const stopping = await sessionRow(session.session_id);

    const result = await decide(session, {
      decision: "close",
      expected_revision: stopping.revision,
      reason: "customer cancelled the engagement",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("closed");
    expect(after.revision).toBe(stopping.revision + 1);
    expect(after.leaseEpoch).toBe(stopping.leaseEpoch + 1);
    // The stream leaves stopping for closed with the row.
    const closedFrames = await statusFrames(session);
    expect(closedFrames.at(-1)).toEqual({
      phase: "stopped",
      admission_state: "closed",
      decision: "close",
      actor: { owner_id: session.ownerId },
    });
    expect(closedFrames.at(-1)).toMatchObject(await readsAs(session));
    expect(await receiptRow(terminated.receipt_id)).toMatchObject({
      status: "failed",
      error: { code: "CONTROL_SUPERSEDED" },
    });
    const [pending] = await db
      .select({ resolvedAt: pendingRequests.resolvedAt })
      .from(pendingRequests)
      .where(eq(pendingRequests.sessionId, session.session_id));
    expect(pending?.resolvedAt).not.toBeNull();
    const [execution] = await db
      .select({ desiredState: executions.desiredState })
      .from(executions)
      .where(eq(executions.id, l.executionId));
    expect(execution?.desiredState).toBe("terminated");
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      resulting_admission_state: "closed",
      checkpoint_revision: null,
      resumable: false,
    });

    // The kill is still observed and settles the binding, but the
    // superseded terminate receipt is not resurrected and the session
    // stays closed.
    expect(await confirmExecutionGone(db, l.executionId)).toEqual({
      sessionReleased: true,
      slotReleased: true,
    });
    const settled = await sessionRow(session.session_id);
    expect(settled.admissionState).toBe("closed");
    expect(settled.executionId).toBeNull();
    expect((await receiptRow(terminated.receipt_id)).status).toBe("failed");
    // The exit behind a close announces nothing further.
    expect(await statusFrames(session)).toEqual(closedFrames);
    // The running turn was left unresolved by the exit and is recorded as
    // unknown; close does not answer it.
    expect((await turnRows(session.session_id))[0]?.status).toBe(
      "outcome_unknown",
    );

    // After close every control and input path is SESSION_CLOSED.
    expect(await resume(session, settled.revision)).toEqual({
      outcome: "rejected",
      admissionState: "closed",
    });
    expect(
      await decide(session, {
        decision: "close",
        expected_revision: settled.revision,
        reason: "again",
      }),
    ).toEqual({ outcome: "rejected", admissionState: "closed" });
    const appended = await inputs().appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: session.ownerId },
      sessionId: session.session_id,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      message: "after close",
    });
    expect(appended).toEqual({ outcome: "rejected", admissionState: "closed" });
  });

  test("close from recovery_required cancels queued input behind the unknown turn and clears the launch signal", async () => {
    const { session, behind, row } = await unknownSession("close-rr", {
      queuedBehind: true,
    });
    const result = await decide(session, {
      decision: "close",
      expected_revision: row.revision,
      reason: "abandon the whole session",
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(await turnRows(session.session_id)).toEqual([
      {
        sequence: 1,
        status: "outcome_unknown",
        terminalReason: "execution_gone",
        outcomeUnknown: true,
      },
      {
        sequence: 2,
        status: "cancelled",
        terminalReason: "closed",
        outcomeUnknown: false,
      },
    ]);
    expect(await queueRows(session.session_id)).toHaveLength(1);
    expect(await receiptRow(behind?.receipt_id ?? "")).toMatchObject({
      status: "failed",
      error: { code: "SESSION_CLOSED" },
    });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.session_id)),
    ).toEqual([]);
  });

  test("resume from stopped: active again, queued input signalled to the last partition, cancelled input stays cancelled", async () => {
    const {
      session,
      launch: l,
      row,
    } = await unknownSession("resume", {
      queuedBehind: true,
      checkpointRevision: 3,
    });
    const decided = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    });
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    const stopped = await sessionRow(session.session_id);

    const result = await resume(session, stopped.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect(result.response.receipt_status).toBe("succeeded");
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("active");
    expect(after.status).toBe("queued");
    expect(after.revision).toBe(stopped.revision + 1);
    expect(after.leaseEpoch).toBe(stopped.leaseEpoch + 1);
    expect(after.checkpointRevision).toBe(3);
    expect(await turnRows(session.session_id)).toMatchObject([
      { sequence: 1, status: "cancelled" },
      { sequence: 2, status: "queued" },
    ]);
    const [signal] = await db
      .select({ partition: unassignedSessions.partition })
      .from(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.session_id));
    expect(signal?.partition).toBe(l.partition);
    // The scheduler now sees it as launchable.
    const demand = await store().inspectDemand({ limit: 100 });
    expect(demand.eligibleSessionIds).toContain(session.session_id);
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      resulting_admission_state: "active",
      checkpoint_revision: 3,
      queued_turn_count: 1,
    });
    const audit = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, session.session_id))
      .orderBy(asc(events.id));
    expect(audit.at(-1)).toEqual({
      type: "status",
      payload: expect.objectContaining({
        phase: "queued",
        admission_state: "active",
        resumed_from_checkpoint_revision: 3,
      }),
    });
  });

  test("after a fallback restore the decision and resume receipts name the revision restored, not the damaged pointer", async () => {
    const { session, row } = await unknownSession("resume-fallback", {
      queuedBehind: true,
      checkpointRevision: 3,
    });
    await db
      .update(sessions)
      .set({ checkpointFallbackRevision: 2 })
      .where(eq(sessions.id, session.session_id));
    const decided = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    });
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    expect(
      (await receiptRow(decided.response.receipt_id)).result,
    ).toMatchObject({ checkpoint_revision: 2 });
    const stopped = await sessionRow(session.session_id);

    const result = await resume(session, stopped.revision);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    expect((await receiptRow(result.response.receipt_id)).result).toEqual({
      resulting_admission_state: "active",
      checkpoint_revision: 2,
      queued_turn_count: 1,
    });
    const audit = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, session.session_id))
      .orderBy(asc(events.id));
    expect(audit.at(-1)?.payload).toMatchObject({
      admission_state: "active",
      resumed_from_checkpoint_revision: 2,
    });
  });

  test("resume with nothing queued goes idle and clears a stale launch signal", async () => {
    const {
      session,
      row,
      launch: launched,
    } = await unknownSession("idle", {
      checkpointRevision: 1,
      checkpointCoversTurn1: true,
    });
    // A signal left over from the create, as terminate would leave it.
    await db
      .insert(unassignedSessions)
      .values({ sessionId: session.session_id })
      .onConflictDoNothing();
    const decided = await decide(session, {
      decision: "confirm_completed",
      expected_revision: row.revision,
      target_turn_id: "1",
      evidence_ref: "ref",
      reason: "verified",
    });
    if (decided.outcome !== "accepted") throw new Error(decided.outcome);
    const stopped = await sessionRow(session.session_id);
    const result = await resume(session, stopped.revision);
    expect(result.outcome).toBe("accepted");
    const after = await sessionRow(session.session_id);
    expect(after.admissionState).toBe("active");
    expect(after.status).toBe("idle");
    expect(
      await db
        .select({ sessionId: unassignedSessions.sessionId })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.session_id)),
    ).toEqual([]);
    // The next message signals again, back to the partition it ran in.
    await append(session, "after resume");
    expect(
      await db
        .select({ partition: unassignedSessions.partition })
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.session_id)),
    ).toEqual([{ partition: launched.partition }]);
  });

  test("resume is RECOVERY_REQUIRED while a turn is unknown or the exit unconfirmed, and refuses other states", async () => {
    const { session, row } = await unknownSession("rr", {
      checkpointRevision: 1,
    });
    expect(await resume(session, row.revision)).toEqual({
      outcome: "recovery_required",
      unconfirmedTurnId: "1",
    });
    expect((await sessionRow(session.session_id)).revision).toBe(row.revision);

    const partition = `stopping-${crypto.randomUUID()}`;
    const bound = await queuedSession(partition);
    const l = await launch(partition, bound.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    await terminate(bound);
    const stopping = await sessionRow(bound.session_id);
    expect(await resume(bound, stopping.revision)).toEqual({
      outcome: "recovery_required",
      unconfirmedTurnId: null,
    });

    const active = await queuedSession(`active-${crypto.randomUUID()}`);
    const activeRow = await sessionRow(active.session_id);
    expect(await resume(active, activeRow.revision)).toEqual({
      outcome: "rejected",
      admissionState: "active",
    });
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, active.session_id));
    // A paused session resumes through, which still needs a
    // restore point this one never had.
    expect(await resume(active, activeRow.revision)).toEqual({
      outcome: "checkpoint_unavailable",
    });
    expect(await resume(active, activeRow.revision + 1)).toEqual({
      outcome: "revision_conflict",
      currentRevision: activeRow.revision,
    });
  });

  test("replay, payload conflict and foreign owner for both commands", async () => {
    const { session, row } = await unknownSession("idem", {
      checkpointRevision: 1,
    });
    const key = crypto.randomUUID();
    const decision: RecoveryDecisionRequest = {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    };
    const first = await decide(session, decision, {
      idempotencyKey: key,
      payloadHash: "hash-a",
    });
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    const replay = await decide(session, decision, {
      idempotencyKey: key,
      payloadHash: "hash-a",
    });
    expect(replay).toEqual({ outcome: "replayed", response: first.response });
    expect(
      await decide(session, decision, {
        idempotencyKey: key,
        payloadHash: "hash-b",
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await decide(
        { session_id: session.session_id, ownerId: "someone-else" },
        decision,
      ),
    ).toEqual({ outcome: "not_found" });

    const stopped = await sessionRow(session.session_id);
    const resumeKey = crypto.randomUUID();
    const resumed = await resume(session, stopped.revision, {
      idempotencyKey: resumeKey,
      payloadHash: "hash-r",
    });
    if (resumed.outcome !== "accepted") throw new Error(resumed.outcome);
    expect(
      await resume(session, stopped.revision, {
        idempotencyKey: resumeKey,
        payloadHash: "hash-r",
      }),
    ).toEqual({ outcome: "replayed", response: resumed.response });
    expect(
      await resume(session, stopped.revision, {
        idempotencyKey: resumeKey,
        payloadHash: "hash-s",
      }),
    ).toEqual({ outcome: "conflict" });
    expect(
      await resume(
        { session_id: session.session_id, ownerId: "someone-else" },
        stopped.revision,
      ),
    ).toEqual({ outcome: "not_found" });
  });

  test("a worker's late finalize replay after an operator decision meets a conflict, not a crash", async () => {
    // A worker that finalized outcome_unknown itself (mirror error) and
    // retries that finalize after the operator abandoned the turn.
    const partition = `late-${crypto.randomUUID()}`;
    const session = await queuedSession(partition);
    const l = await launch(partition, session.session_id);
    const claimed = await claim(l);
    await gateway.nextInput(principalOf(claimed), scopeOf(claimed));
    const finalize = () =>
      gateway.finalize(principalOf(claimed), {
        ...scopeOf(claimed),
        turn_id: "1",
        finalize_key: "fin-1",
        final_source_sequence: 0,
        terminal: {
          status: "outcome_unknown",
          reason: "mirror_error",
          result: { text: "partial" },
          usage: null,
        },
        checkpoint: null,
      });
    expect((await finalize()).status).toBe("outcome_unknown");
    expect(await confirmExecutionGone(db, l.executionId)).toMatchObject({
      sessionReleased: true,
    });
    const row = await sessionRow(session.session_id);
    expect(row.admissionState).toBe("recovery_required");
    const decided = await decide(session, {
      decision: "abandon",
      expected_revision: row.revision,
      target_turn_id: "1",
      reason: "mirror failed, output discarded",
    });
    expect(decided.outcome).toBe("accepted");
    const [turn] = await db
      .select({ resultJson: turns.resultJson })
      .from(turns)
      .where(eq(turns.sessionId, session.session_id));
    expect(turn?.resultJson).toEqual({
      result: { text: "partial" },
      usage: null,
      operator_decision: {
        decision: "abandon",
        evidence_ref: null,
        reason: "mirror failed, output discarded",
      },
    });
    // The old attempt is fenced out; a replay from it is a plain 409, and
    // the turn keeps the operator's terminal.
    await expect(finalize()).rejects.toMatchObject({ status: 409 });
    expect((await turnRows(session.session_id))[0]?.status).toBe("cancelled");
  });

  test("close through recovery is refused for a session with nothing to recover", async () => {
    const active = await queuedSession(`close-active-${crypto.randomUUID()}`);
    const activeRow = await sessionRow(active.session_id);
    expect(
      await decide(active, {
        decision: "close",
        expected_revision: activeRow.revision,
        reason: "ordinary close",
      }),
    ).toEqual({ outcome: "not_in_recovery", admissionState: "active" });

    // Stopped and resumable: an ordinary close too.
    const resumable = await unknownSession("close-resumable", {
      checkpointRevision: 1,
    });
    const abandoned = await decide(resumable.session, {
      decision: "abandon",
      expected_revision: resumable.row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    });
    expect(abandoned.outcome).toBe("accepted");
    const stopped = await sessionRow(resumable.session.session_id);
    expect(
      await decide(resumable.session, {
        decision: "close",
        expected_revision: stopped.revision,
        reason: "ordinary close",
      }),
    ).toEqual({ outcome: "not_in_recovery", admissionState: "stopped" });
    expect(
      (await sessionRow(resumable.session.session_id)).admissionState,
    ).toBe("stopped");

    // Stopped without a checkpoint cannot resume, so close is the way out.
    const stuck = await unknownSession("close-stuck");
    const abandonedStuck = await decide(stuck.session, {
      decision: "abandon",
      expected_revision: stuck.row.revision,
      target_turn_id: "1",
      reason: "reviewed",
    });
    expect(abandonedStuck.outcome).toBe("accepted");
    const stuckRow = await sessionRow(stuck.session.session_id);
    expect(
      (
        await decide(stuck.session, {
          decision: "close",
          expected_revision: stuckRow.revision,
          reason: "no checkpoint to resume",
        })
      ).outcome,
    ).toBe("accepted");
  });

  test("a session with no execution ever (legacy pod binding) cannot be resumed", async () => {
    const session = await queuedSession(`legacy-${crypto.randomUUID()}`);
    await db
      .update(sessions)
      .set({
        admissionState: "stopped",
        status: "stopped",
        podId: `pod-${crypto.randomUUID()}`,
        checkpointRevision: 1,
      })
      .where(eq(sessions.id, session.session_id));
    const row = await sessionRow(session.session_id);
    expect(await resume(session, row.revision)).toEqual({
      outcome: "unsupported",
    });
    expect(
      await decide(session, {
        decision: "close",
        expected_revision: row.revision,
        reason: "legacy",
      }),
    ).toEqual({ outcome: "unsupported" });
    // Sanity: the launch registry is untouched by any of the above.
    expect(
      await db
        .select({ id: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.sessionId, session.session_id)),
    ).toEqual([]);
  });
});
