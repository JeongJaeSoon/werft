import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WorkerScope } from "@werft-ai/contracts";
import {
  type CheckpointProtocol,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
  withSeededInstallation,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { reconcileExpiredLeases } from "./lease-reconcile.ts";
import { createPostgresWorkerPendingStore } from "./pending-control.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import { RESUME_LAUNCH_LIMIT } from "./resume-control.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  executions,
  receipts,
  sessionPinCutover,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
const MANIFEST_SHA = "c".repeat(64);
const FINGERPRINT = {
  engine: "claude",
  sdk_version: "0.3.270",
  cli_version: "2.1.270",
  profile_sha256: "d".repeat(64),
};

const SPEC = {
  image: "sha256:worker",
  resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
};

const catalog: SessionCatalog = withSeededInstallation({
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
});

integration(
  "resume from paused and pause cancellation preserve the PostgreSQL receipt contract",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let gateway: WorkerGateway;
    // What the checkpoint service says about the pointer a restore asks for.
    let restoreAnswer: Awaited<
      ReturnType<CheckpointProtocol["getRestorePlan"]>
    >;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "resume_it" });
      pool = new Pool({ connectionString: database.url, max: 12 });
      db = drizzle(pool, { schema });
      gateway = createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog,
        checkpoints: {
          async verify() {
            return { status: "verified" };
          },
        },
        checkpointProtocol: {
          async requestCheckpoint() {
            throw new Error("not used");
          },
          async getRestorePlan() {
            return restoreAnswer;
          },
        },
        pending: createPostgresWorkerPendingStore(db),
        options: {
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
          leaseTtlMs: 60_000,
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
    const reader = () => createPostgresSessionReader(db);
    const scheduler = () =>
      createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      });

    type Worker = {
      principal: WorkerPrincipal;
      scope: WorkerScope;
      executionId: string;
    };
    type Session = { sessionId: string; ownerId: string; partition: string };

    async function newSession(name: string): Promise<Session> {
      const partition = `${name}-${crypto.randomUUID()}`;
      const ownerId = `owner-${crypto.randomUUID()}`;
      const accepted = await inputs().acceptInputAtomic({
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
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
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
      return { sessionId, ownerId, partition };
    }

    function workerOf(
      claimed: Awaited<ReturnType<WorkerGateway["bootstrapClaim"]>>,
      executionId: string,
    ): Worker {
      return {
        principal: {
          kind: "session",
          attemptId: claimed.attempt_id,
          sessionId: claimed.session_id,
          leaseEpoch: claimed.lease_epoch,
          executionGeneration: claimed.execution_generation,
          authRevision: claimed.auth_revision,
        },
        scope: {
          session_id: claimed.session_id,
          turn_id: null,
          attempt_id: claimed.attempt_id,
          lease_epoch: claimed.lease_epoch,
          execution_generation: claimed.execution_generation,
          auth_revision: claimed.auth_revision,
        },
        executionId,
      };
    }

    async function claim(session: Session): Promise<Worker> {
      const { executionId, generation, nonce } = await launchSession(db, {
        sessionId: session.sessionId,
      });
      const claimed = await gateway.bootstrapClaim(bootstrap, {
        execution_id: executionId,
        execution_generation: generation,
        credential: { kind: "launch_nonce", nonce },
      });
      expect(claimed.session_id).toBe(session.sessionId);
      return workerOf(claimed, executionId);
    }

    // The scheduler's own path: demand, reservation, nonce, claim.
    async function reserve(session: Session) {
      const store = scheduler();
      const demand = await store.inspectDemand({ limit: 1_000 });
      expect(demand.eligibleSessionIds).toContain(session.sessionId);
      const intent = await store.reserveLaunch({
        ...SPEC,
        backend: "local_docker",
        now: new Date(),
        sessionId: session.sessionId,
        slotLimit: 1_000,
      });
      if (!intent) throw new Error("no reservation");
      return intent;
    }

    async function claimReserved(session: Session) {
      const intent = await reserve(session);
      const nonce = await scheduler().issueBootstrapNonce({
        executionId: intent.executionId,
        generation: intent.generation,
      });
      const claimed = await gateway.bootstrapClaim(bootstrap, {
        execution_id: intent.executionId,
        execution_generation: intent.generation,
        credential: { kind: "launch_nonce", nonce },
      });
      expect(claimed.session_id).toBe(session.sessionId);
      return { worker: workerOf(claimed, intent.executionId), claimed };
    }

    async function deliver(worker: Worker): Promise<string> {
      const next = await gateway.nextInput(worker.principal, worker.scope);
      if (!next.input) throw new Error("no input delivered");
      return next.input.turn_id;
    }

    function finalize(worker: Worker, turnId: string, revision: number | null) {
      return gateway.finalize(worker.principal, {
        ...worker.scope,
        turn_id: turnId,
        finalize_key: `${worker.scope.attempt_id}:${turnId}`,
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
                manifest_ref: `manifests/${worker.scope.session_id}/${revision}`,
                manifest_sha256: MANIFEST_SHA,
              },
      });
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
          attemptId: turns.attemptId,
        })
        .from(turns)
        .where(eq(turns.sessionId, sessionId))
        .orderBy(asc(turns.sequence));
    }

    function control(
      kind: "pause" | "resume" | "terminate",
      session: Session,
      expectedRevision: number,
      idempotencyKey: string = crypto.randomUUID(),
    ) {
      const common = {
        principal: { ownerId: session.ownerId },
        sessionId: session.sessionId,
        idempotencyKey,
        payloadHash: `${kind}:${expectedRevision}`,
        expectedRevision,
        now: new Date(),
      };
      return kind === "resume"
        ? controls().resumeAtomic(common)
        : kind === "pause"
          ? controls().pauseAtomic({ ...common, reason: null })
          : controls().terminateAtomic({ ...common, reason: null });
    }

    async function accepted(
      kind: "pause" | "resume" | "terminate",
      session: Session,
    ) {
      const row = await sessionRow(session.sessionId);
      const result = await control(kind, session, row.revision);
      if (result.outcome !== "accepted") throw new Error(result.outcome);
      return result.response;
    }

    async function append(session: Session, message: string) {
      return inputs().appendInputAtomic({
        principal: { ownerId: session.ownerId },
        sessionId: session.sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message,
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      });
    }

    // The admission states the public event stream carried, in order.
    async function admissionEvents(session: Session) {
      const page = await reader().readEvents(
        session.ownerId,
        session.sessionId,
        { limit: 100, maxBytes: 1024 * 1024 },
      );
      return (page?.items ?? []).flatMap((item) => {
        const data = item.data.data as { admission_state?: string } | null;
        return item.event === "status" && data?.admission_state
          ? [data.admission_state]
          : [];
      });
    }

    async function failure(work: Promise<unknown>) {
      try {
        await work;
      } catch (error) {
        if (error instanceof WorkerGatewayError) return error.code;
        throw error;
      }
      throw new Error("expected the call to fail");
    }

    // Turn 1 ran and committed checkpoint 0; the pause drained, released and
    // was seen gone. A second input waits in the queue.
    async function pausedSession(name: string) {
      const session = await newSession(name);
      const worker = await claim(session);
      const turn = await deliver(worker);
      const queued = await append(session, "second input waits for the resume");
      expect(queued.outcome).toBe("accepted");
      const pause = await accepted("pause", session);
      await finalize(worker, turn, 0);
      expect(
        await gateway.release(worker.principal, {
          ...worker.scope,
          reason: "pause",
          pause_control_id: pause.receipt_id,
        }),
      ).toEqual({ released: true });
      await confirmExecutionGone(db, worker.executionId);
      const row = await sessionRow(session.sessionId);
      expect(row.admissionState).toBe("paused");
      expect(row.checkpointRevision).toBe(0);
      return { session, first: worker, pause };
    }

    test("a paused session that carries an ended status and has no pin is not resumed once the pin is authoritative", async () => {
      const { session } = await pausedSession("pin-required");
      await db
        .update(sessions)
        .set({ status: "stopped" })
        .where(eq(sessions.id, session.sessionId));
      const before = await sessionRow(session.sessionId);
      await db
        .update(sessionPinCutover)
        .set({ authoritative: true, flippedAt: new Date() });
      try {
        expect(await control("resume", session, before.revision)).toEqual({
          outcome: "pin_required",
        });
        expect(await sessionRow(session.sessionId)).toEqual(before);
      } finally {
        await db
          .update(sessionPinCutover)
          .set({ authoritative: false, flippedAt: null });
      }
    });

    test("paused → resume 202 resuming → reserved claim → no input before ready → ready: active, receipt succeeded, queue resumes in order", async () => {
      const { session } = await pausedSession("happy");
      const before = await sessionRow(session.sessionId);

      const resume = await accepted("resume", session);
      expect(resume.receipt_status).toBe("accepted");
      const resuming = await sessionRow(session.sessionId);
      expect(resuming.admissionState).toBe("resuming");
      expect(resuming.revision).toBe(before.revision + 1);
      expect(resuming.leaseEpoch).toBeGreaterThan(before.leaseEpoch);

      // Messages wait for the restore; the pause family's own refusal is gone.
      expect(await append(session, "not yet")).toEqual({
        outcome: "rejected",
        admissionState: "resuming",
      });
      expect(await control("pause", session, resuming.revision)).toEqual({
        outcome: "rejected",
        admissionState: "resuming",
      });

      // The scheduler launches for it, and the new worker is told what to restore.
      const { worker, claimed } = await claimReserved(session);
      expect(claimed.restore).toEqual({
        revision: 0,
        manifest_ref: `manifests/${session.sessionId}/0`,
        manifest_sha256: MANIFEST_SHA,
      });
      expect(claimed.execution_generation).toBe(2);
      restoreAnswer = {
        status: "ready",
        plan: {
          artifacts: [],
          cwd: "/workspace",
          engine: "claude",
          gitCommit: "e".repeat(40),
          manifestRef: `manifests/${session.sessionId}/0`,
          manifestSha256: MANIFEST_SHA,
          objectKeys: [],
          resume: "sdk-session",
          revision: 0,
        },
      };
      const plan = await gateway.restorePlan(worker.principal, {
        ...worker.scope,
        runtime: FINGERPRINT,
      });
      expect(plan.status).toBe("ready");

      // Nothing queued is handed out before ready.
      const early = await gateway.nextInput(worker.principal, worker.scope);
      expect(early.input).toBeNull();
      expect((await receiptRow(resume.receipt_id)).status).toBe("accepted");

      expect(
        await gateway.ready(worker.principal, {
          ...worker.scope,
          restored_revision: 0,
        }),
      ).toEqual({ activated: true });
      const active = await sessionRow(session.sessionId);
      expect(active.admissionState).toBe("active");
      // Completing the resume is not a new decision: the revision stays.
      expect(active.revision).toBe(resuming.revision);
      const receipt = await receiptRow(resume.receipt_id);
      expect(receipt.status).toBe("succeeded");
      expect(receipt.result).toEqual({
        resulting_admission_state: "active",
        checkpoint_revision: 0,
        queued_turn_count: 1,
      });
      // A second report changes nothing.
      expect(
        await gateway.ready(worker.principal, {
          ...worker.scope,
          restored_revision: 0,
        }),
      ).toEqual({ activated: false });

      // FIFO: the input queued before the pause first, then one sent after.
      expect((await append(session, "third input")).outcome).toBe("accepted");
      expect(await deliver(worker)).toBe("2");
      await finalize(worker, "2", 1);
      expect(await deliver(worker)).toBe("3");

      // The whole story reads back through the public event stream.
      expect(await admissionEvents(session)).toEqual([
        "pausing",
        "paused",
        "resuming",
        "active",
      ]);
    });

    test("a resume with nothing queued still launches a worker to prove the restore", async () => {
      const session = await newSession("empty");
      const worker = await claim(session);
      const turn = await deliver(worker);
      const pause = await accepted("pause", session);
      await finalize(worker, turn, 0);
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "pause",
        pause_control_id: pause.receipt_id,
      });
      await confirmExecutionGone(db, worker.executionId);

      const resume = await accepted("resume", session);
      const signal = await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, session.sessionId));
      expect(signal).toHaveLength(1);
      const { worker: second } = await claimReserved(session);
      await gateway.ready(second.principal, {
        ...second.scope,
        restored_revision: 0,
      });
      const receipt = await receiptRow(resume.receipt_id);
      expect(receipt.status).toBe("succeeded");
      expect(receipt.result).toMatchObject({ queued_turn_count: 0 });
      expect((await sessionRow(session.sessionId)).status).toBe("idle");
    });

    test("a restore refusal from the checkpoint service puts the session in recovery_required and fails the receipt with its code", async () => {
      const { session } = await pausedSession("incompatible");
      const resume = await accepted("resume", session);
      const { worker } = await claimReserved(session);
      restoreAnswer = {
        status: "incompatible",
        code: "INCOMPATIBLE_CHECKPOINT",
        mismatches: [
          { field: "sdkVersion", expected: "0.3.270", found: "0.3.1" },
        ],
      };
      expect(
        await gateway.restorePlan(worker.principal, {
          ...worker.scope,
          runtime: FINGERPRINT,
        }),
      ).toMatchObject({ status: "incompatible" });

      const row = await sessionRow(session.sessionId);
      expect(row.admissionState).toBe("recovery_required");
      const receipt = await receiptRow(resume.receipt_id);
      expect(receipt.status).toBe("failed");
      expect(receipt.error).toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
      expect(JSON.stringify(receipt.error)).toContain("sdkVersion");
      // Nothing reaches the queue, and a late ready cannot undo the failure.
      expect(
        (await gateway.nextInput(worker.principal, worker.scope)).input,
      ).toBeNull();
      expect(
        await gateway.ready(worker.principal, {
          ...worker.scope,
          restored_revision: 0,
        }),
      ).toEqual({ activated: false });
      expect((await receiptRow(resume.receipt_id)).status).toBe("failed");
      // The exit that follows keeps it there.
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "restore failed",
      });
      await confirmExecutionGone(db, worker.executionId);
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
    });

    test("a damaged manifest (unavailable) and a worker reporting another revision both fail the resume", async () => {
      const damaged = await pausedSession("damaged");
      const damagedResume = await accepted("resume", damaged.session);
      const { worker } = await claimReserved(damaged.session);
      restoreAnswer = {
        status: "unavailable",
        code: "CHECKPOINT_UNAVAILABLE",
        reason: "manifest sha256 does not match the committed pointer",
      };
      await gateway.restorePlan(worker.principal, {
        ...worker.scope,
        runtime: FINGERPRINT,
      });
      expect((await sessionRow(damaged.session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect((await receiptRow(damagedResume.receipt_id)).error).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });

      const other = await pausedSession("mismatch");
      const otherResume = await accepted("resume", other.session);
      const { worker: second } = await claimReserved(other.session);
      expect(
        await failure(
          gateway.ready(second.principal, {
            ...second.scope,
            restored_revision: 7,
          }),
        ),
      ).toBe("CHECKPOINT_UNAVAILABLE");
      expect((await sessionRow(other.session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect((await receiptRow(otherResume.receipt_id)).status).toBe("failed");
    });

    test("a resume whose pointer stopped covering the last turn fails at the claim, with its receipt", async () => {
      const { session } = await pausedSession("gap");
      const resume = await accepted("resume", session);
      // A blocker recorded after the pause leaves the pointer untrusted, so
      // nothing restorable covers turn 1 any more.
      await db
        .update(sessions)
        .set({ checkpointPendingReason: "mirror_error" })
        .where(eq(sessions.id, session.sessionId));
      const intent = await reserve(session);
      const nonce = await scheduler().issueBootstrapNonce({
        executionId: intent.executionId,
        generation: intent.generation,
      });
      expect(
        await failure(
          gateway.bootstrapClaim(bootstrap, {
            execution_id: intent.executionId,
            execution_generation: intent.generation,
            credential: { kind: "launch_nonce", nonce },
          }),
        ),
      ).toBe("RECOVERY_REQUIRED");
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect(await receiptRow(resume.receipt_id)).toMatchObject({
        status: "failed",
        error: { code: "RECOVERY_REQUIRED" },
      });
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toHaveLength(0);
    });

    test("claimed workers that end before ready are relaunched up to the limit, then the resume fails; a launch that never claimed spends nothing", async () => {
      const { session } = await pausedSession("gone");
      const resume = await accepted("resume", session);
      const signalled = async () =>
        (
          await db
            .select()
            .from(unassignedSessions)
            .where(eq(unassignedSessions.sessionId, session.sessionId))
        ).length;

      // Reserved, never claimed: its resource going proves nothing.
      const intent = await reserve(session);
      await confirmExecutionGone(db, intent.executionId);
      const still = await sessionRow(session.sessionId);
      expect(still.admissionState).toBe("resuming");
      expect(still.executionId).toBeNull();
      expect((await receiptRow(resume.receipt_id)).status).toBe("accepted");
      expect(await signalled()).toBe(1);

      // A claimed one dying before its report (a deploy's SIGTERM, a slow
      // workspace) is retried on the same checkpoint, input still held.
      for (let launch = 1; launch < RESUME_LAUNCH_LIMIT; launch++) {
        const { worker } = await claimReserved(session);
        await confirmExecutionGone(db, worker.executionId);
        expect((await sessionRow(session.sessionId)).admissionState).toBe(
          "resuming",
        );
        expect((await receiptRow(resume.receipt_id)).status).toBe("accepted");
        expect(await signalled()).toBe(1);
      }

      // The last allowed one dies too: an operator decides.
      const { worker } = await claimReserved(session);
      await confirmExecutionGone(db, worker.executionId);
      const failed = await sessionRow(session.sessionId);
      expect(failed.admissionState).toBe("recovery_required");
      const receipt = await receiptRow(resume.receipt_id);
      expect(receipt.status).toBe("failed");
      expect(receipt.error).toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect((await turnRows(session.sessionId)).at(-1)?.status).toBe("queued");
      // Nobody is launched for it any more.
      expect(
        (await scheduler().inspectDemand({ limit: 1_000 })).eligibleSessionIds,
      ).not.toContain(session.sessionId);
    });

    test("resume during the drain cancels the pause: same worker, same turn finished once, pause receipt PAUSE_CANCELLED", async () => {
      const session = await newSession("cancel");
      const worker = await claim(session);
      const turn = await deliver(worker);
      const pause = await accepted("pause", session);
      const pausing = await sessionRow(session.sessionId);

      const resume = await accepted("resume", session);
      expect(resume.receipt_status).toBe("succeeded");
      const active = await sessionRow(session.sessionId);
      expect(active.admissionState).toBe("active");
      expect(active.revision).toBe(pausing.revision + 1);
      // The drainer keeps its epoch and lease.
      expect(active.leaseEpoch).toBe(pausing.leaseEpoch);
      const pauseReceipt = await receiptRow(pause.receipt_id);
      expect(pauseReceipt.status).toBe("failed");
      expect(pauseReceipt.error).toMatchObject({ code: "PAUSE_CANCELLED" });
      expect((await receiptRow(resume.receipt_id)).result).toEqual({
        resulting_admission_state: "active",
        checkpoint_revision: null,
        queued_turn_count: 0,
      });

      // The turn in flight finishes on the same attempt; nothing re-runs it.
      await finalize(worker, turn, 0);
      // The worker's pause release is the one that learns of the cancel.
      expect(
        await failure(
          gateway.release(worker.principal, {
            ...worker.scope,
            reason: "pause",
            pause_control_id: pause.receipt_id,
          }),
        ),
      ).toBe("REQUEST_STALE");
      expect((await append(session, "after the cancel")).outcome).toBe(
        "accepted",
      );
      expect(await deliver(worker)).toBe("2");
      expect(await turnRows(session.sessionId)).toEqual([
        {
          sequence: 1,
          status: "completed",
          attemptId: worker.scope.attempt_id,
        },
        { sequence: 2, status: "running", attemptId: worker.scope.attempt_id },
      ]);
      const executionRows = await db
        .select({ desiredState: executions.desiredState })
        .from(executions)
        .where(eq(executions.id, worker.executionId));
      expect(executionRows[0]?.desiredState).toBe("running");
    });

    test("resume after the stop intent, or once the drainer is gone, is PAUSE_COMMITTING", async () => {
      const session = await newSession("committing");
      const worker = await claim(session);
      const turn = await deliver(worker);
      const pause = await accepted("pause", session);
      await finalize(worker, turn, 0);
      await gateway.release(worker.principal, {
        ...worker.scope,
        reason: "pause",
        pause_control_id: pause.receipt_id,
      });
      const committing = await sessionRow(session.sessionId);
      expect(committing.admissionState).toBe("pausing");
      expect(await control("resume", session, committing.revision)).toEqual({
        outcome: "pause_committing",
      });
      expect((await receiptRow(pause.receipt_id)).status).toBe("accepted");

      const drained = await newSession("drained");
      const leaving = await claim(drained);
      const leavingTurn = await deliver(leaving);
      await accepted("pause", drained);
      await finalize(leaving, leavingTurn, 0);
      // A SIGTERM drain gives the session back without committing the pause.
      await gateway.release(leaving.principal, {
        ...leaving.scope,
        reason: "drained",
      });
      const row = await sessionRow(drained.sessionId);
      expect(await control("resume", drained, row.revision)).toEqual({
        outcome: "pause_committing",
      });
    });

    test("a pause stuck on mirror_error is not cancelled into active: recovery_required with both receipts failed", async () => {
      const session = await newSession("mirror");
      const worker = await claim(session);
      await deliver(worker);
      const pause = await accepted("pause", session);
      await db
        .update(sessions)
        .set({
          checkpointPendingReason: "mirror_error",
          checkpointPendingAttemptId: worker.scope.attempt_id,
        })
        .where(eq(sessions.id, session.sessionId));

      const resume = await accepted("resume", session);
      expect(resume.receipt_status).toBe("failed");
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect((await receiptRow(pause.receipt_id)).status).toBe("failed");
      expect((await receiptRow(resume.receipt_id)).error).toMatchObject({
        code: "CHECKPOINT_UNAVAILABLE",
      });
    });

    test("pause, resume and terminate racing on one revision: one wins, the rest are revision conflicts", async () => {
      const { session } = await pausedSession("race");
      const row = await sessionRow(session.sessionId);
      const results = await Promise.all([
        control("resume", session, row.revision),
        control("terminate", session, row.revision),
        control("resume", session, row.revision),
        control("pause", session, row.revision),
      ]);
      const outcomes = results.map((result) => result.outcome);
      expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(
        1,
      );
      expect(
        outcomes.filter((outcome) => outcome === "revision_conflict"),
      ).toHaveLength(3);

      const live = await newSession("race-active");
      const worker = await claim(live);
      await deliver(worker);
      await accepted("pause", live);
      const pausing = await sessionRow(live.sessionId);
      const racing = await Promise.all([
        control("resume", live, pausing.revision),
        control("terminate", live, pausing.revision),
      ]);
      expect(
        racing.filter((result) => result.outcome === "accepted"),
      ).toHaveLength(1);
      expect(
        racing.filter((result) => result.outcome === "revision_conflict"),
      ).toHaveLength(1);
    });

    // the held attempt was the only one that could commit the pause.
    async function blockedPauseLosesItsWorker(
      name: string,
      reason: string | null,
    ) {
      const session = await newSession(name);
      const worker = await claim(session);
      const turn = await deliver(worker);
      expect((await append(session, "queued behind the pause")).outcome).toBe(
        "accepted",
      );
      const pause = await accepted("pause", session);
      // The turn ends without a checkpoint, so the pause is refused and held.
      await finalize(worker, turn, null);
      if (reason !== null) {
        await db
          .update(sessions)
          .set({
            checkpointPendingReason: reason,
            checkpointPendingAttemptId: worker.scope.attempt_id,
          })
          .where(eq(sessions.id, session.sessionId));
      }
      expect(
        await failure(
          gateway.release(worker.principal, {
            ...worker.scope,
            reason: "pause",
            pause_control_id: pause.receipt_id,
          }),
        ),
      ).toBe("CHECKPOINT_UNAVAILABLE");
      // Its lease runs out; the reconciler fences it and asks for the kill.
      await db
        .update(attempts)
        .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(attempts.id, worker.scope.attempt_id));
      const reconciled = await reconcileExpiredLeases(db, {});
      expect(reconciled.map((lease) => lease.attemptId)).toContain(
        worker.scope.attempt_id,
      );
      await confirmExecutionGone(db, worker.executionId);
      return { session, pause };
    }

    test("a blocked pause whose worker is lost fails, and the turn its checkpoint never covered sends the session to an operator", async () => {
      const { session, pause } = await blockedPauseLosesItsWorker("lost", null);
      const row = await sessionRow(session.sessionId);
      // The pause fails back to active, but the queued input would run on a
      // new engine session without the turn that ran: a context gap.
      expect(row.admissionState).toBe("recovery_required");
      expect(row.executionId).toBeNull();
      const receipt = await receiptRow(pause.receipt_id);
      expect(receipt.status).toBe("failed");
      expect(receipt.error).toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
      expect(JSON.stringify(receipt.error)).toContain("checkpoint_unavailable");
      expect(await admissionEvents(session)).toEqual([
        "pausing",
        "active",
        "recovery_required",
      ]);
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toHaveLength(0);
      // Nothing is left open for the pause.
      expect(
        await db
          .select({ id: receipts.id })
          .from(receipts)
          .where(
            and(
              eq(receipts.operation, "pause"),
              eq(receipts.status, "accepted"),
              sql`${receipts.targetRef}->>'session_id' = ${session.sessionId}`,
            ),
          ),
      ).toEqual([]);
    });

    test("a pause blocked on mirror_error whose worker is lost goes to recovery_required", async () => {
      const { session, pause } = await blockedPauseLosesItsWorker(
        "lost-mirror",
        "mirror_error",
      );
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect((await receiptRow(pause.receipt_id)).error).toMatchObject({
        code: "RECOVERY_REQUIRED",
      });
      expect(await admissionEvents(session)).toEqual([
        "pausing",
        "recovery_required",
      ]);
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toEqual([]);
    });

    test("a pause blocked on a reason this build does not know is treated as blocking when its worker is lost", async () => {
      const { session, pause } = await blockedPauseLosesItsWorker(
        "lost-unknown",
        "a_reason_from_a_newer_build",
      );
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
      expect((await receiptRow(pause.receipt_id)).error).toMatchObject({
        code: "RECOVERY_REQUIRED",
      });
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toEqual([]);
    });

    test("terminate while resuming fails the resume receipt as superseded, and a replayed resume answers with it", async () => {
      const { session } = await pausedSession("superseded");
      const key = crypto.randomUUID();
      const row = await sessionRow(session.sessionId);
      const first = await control("resume", session, row.revision, key);
      if (first.outcome !== "accepted") throw new Error(first.outcome);
      await accepted("terminate", session);
      const receipt = await receiptRow(first.response.receipt_id);
      expect(receipt.status).toBe("failed");
      expect(receipt.error).toMatchObject({ code: "CONTROL_SUPERSEDED" });
      expect(await control("resume", session, row.revision, key)).toEqual({
        outcome: "replayed",
        response: {
          receipt_id: first.response.receipt_id,
          receipt_status: "failed",
        },
      });
      const open = await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(
          and(
            eq(receipts.operation, "resume"),
            eq(receipts.status, "accepted"),
          ),
        );
      expect(open.map((r) => r.id)).not.toContain(first.response.receipt_id);
    });

    test("a resume whose launch exhausts the startup attempts fails as a resume and keeps the queued input", async () => {
      const { session } = await pausedSession("quarantine");
      const resume = await accepted("resume", session);
      const intent = await reserve(session);
      expect(
        await scheduler().recordLaunchFailure(intent, {
          error: "Image worker:gone is not on this daemon",
          expectedAttempts: 0,
          expectedCount: 0,
          quarantine: true,
          retryDelayMs: 60_000,
        }),
      ).toBe("quarantined");

      const row = await sessionRow(session.sessionId);
      expect(row.admissionState).toBe("recovery_required");
      expect(await receiptRow(resume.receipt_id)).toMatchObject({
        status: "failed",
        error: { code: "LAUNCH_FAILED" },
      });
      expect((await turnRows(session.sessionId)).at(-1)?.status).toBe("queued");
      expect(
        await db
          .select()
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.sessionId)),
      ).toEqual([]);
      expect((await admissionEvents(session)).at(-1)).toBe("recovery_required");
      // The kill confirmed later does not reopen anything.
      await confirmExecutionGone(db, intent.executionId);
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "recovery_required",
      );
    });

    test("a resume past the session's cost limit is held resuming, unlaunched, until the limit rises or a terminate closes it", async () => {
      const { session } = await pausedSession("budget");
      await db
        .update(sessions)
        .set({ costUsd: 1_000 })
        .where(eq(sessions.id, session.sessionId));
      const resume = await accepted("resume", session);
      expect((await sessionRow(session.sessionId)).admissionState).toBe(
        "resuming",
      );

      const store = scheduler();
      expect(
        (await store.inspectDemand({ limit: 1_000 })).eligibleSessionIds,
      ).not.toContain(session.sessionId);
      expect(
        await store.reserveLaunch({
          ...SPEC,
          backend: "local_docker",
          now: new Date(),
          sessionId: session.sessionId,
          slotLimit: 1_000,
        }),
      ).toBeNull();
      expect((await receiptRow(resume.receipt_id)).status).toBe("accepted");

      // An operator raising the limit lets the same resume go on.
      const raised = createPostgresSchedulerStore(db, {
        connectForLock: () => pool.connect(),
        sessionCostLimitUsd: 2_000,
        sessionTokenLimit: null,
      });
      expect(
        (await raised.inspectDemand({ limit: 1_000 })).eligibleSessionIds,
      ).toContain(session.sessionId);

      await accepted("terminate", session);
      expect(await receiptRow(resume.receipt_id)).toMatchObject({
        status: "failed",
        error: { code: "CONTROL_SUPERSEDED" },
      });
    });
  },
);
