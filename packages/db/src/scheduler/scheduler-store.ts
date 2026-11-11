import { randomUUID } from "node:crypto";
import {
  type ExecutionBackend as ExecutionBackendKind,
  executionBackendSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  ActiveExecution,
  DrainState,
  ExecutionObservation,
  ExecutionRef,
  LaunchCredentialState,
  LaunchFailureInput,
  LaunchFailureOutcome,
  PassLock,
  ReplaceReason,
  ReserveLaunchInput,
  SchedulerDemand,
  SchedulerStore,
  SessionBudget,
  StoredLaunchIntent,
  WorkerImageRefusal,
} from "@werft-ai/platform";
import {
  budgetExceeded,
  DEFAULT_NONCE_TTL_MS,
  generateLaunchNonce,
  hashWorkerToken,
  launchNonceFingerprint,
  parseExecutionResources,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { readPointerImageRuntime } from "../checkpoints/checkpoint-runtime.ts";
import {
  LAUNCHABLE_ADMISSION_STATES,
  OPEN_TURN_STATUSES,
  UUID,
  withinBudget,
} from "../control-shared.ts";
import { expireOverdueTerminations } from "../control-unit-of-work.ts";
import { DB_NOW, dbNow, fromDbNow } from "../db-clock.ts";
import { launchFailedCause, quarantineLaunch } from "../launch-quarantine.ts";
import type { Database } from "../queries.ts";
import {
  holdIncompatibleBeforeLaunch,
  restoreRetryDue,
} from "../restore-failures.ts";
import {
  executions,
  sessions,
  turns,
  unassignedSessions,
  workerImageRefusals,
  workerLaunches,
} from "../schema.ts";
import { createPostgresWorkerUnitOfWork } from "../worker-unit-of-work.ts";

/** A connection the pass lock can live on for as long as the pass runs. */
export type PassLockClient = {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** An error hands the client back to be destroyed, not reused. */
  release(error?: Error): void;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
};

export type PostgresSchedulerStoreOptions = {
  /**
   * Hands out a dedicated client for the session-level advisory lock; the
   * pool's regular clients would return the lock to the pool with them.
   */
  connectForLock: () => Promise<PassLockClient>;
  /** Lifetime of a bootstrap nonce; matches the gateway's own default. */
  nonceTtlMs?: number;
  /**
   * SESSION_COST_LIMIT_USD. A session that has spent it is not launched for:
   * its worker would be told to release at its first poll, and the next pass
   * would launch another, round and round.
   */
  sessionCostLimitUsd: number;
  /** SESSION_TOKEN_LIMIT, for the same reason; null, none. */
  sessionTokenLimit: number | null;
  logger?: StructuredLogger;
};

const PASS_LOCK_KEY = "scheduler:pass";

const DESIRED_RUNNING = "running";

/**
 * The one admission state a session never comes back from. Everything else
 * is resumed into the same session, and its workspace is kept — `stopped`
 * only until its TTL runs out, and then only through
 * `claimWorkspaceReclaim`, which resume waits for. A stopped session resumes
 * from its checkpoint, which the worker restores over whatever the volume
 * held, so its volume is a cache past that point, not the session's work.
 */
const FINAL_ADMISSION_STATES: Array<
  (typeof sessions.admissionState.enumValues)[number]
> = ["closed"];

/**
 * What `last_launch_error` and the failed input's receipt keep of the
 * provider's message. Enough to name the image or the daemon's refusal;
 * the scheduler's log has the rest.
 */
const LAUNCH_ERROR_MAX_CHARS = 1_000;

/**
 * Overdue terminate receipts one pass turns `unknown`. A backlog
 * is worked off over several passes, as the reconciler's batch does, rather
 * than in one statement that can outlast the pass.
 */
export const OVERDUE_TERMINATION_SWEEP_LIMIT = 100;

/**
 * The one ledger. A launch holds its slot — and its session — from the
 * moment it is reserved until `confirmExecutionGone` hands both back, so
 * nothing else gets to count capacity.
 */
function holdsSlot() {
  return isNull(workerLaunches.slotReleasedAt);
}

/**
 * The launch queue: the `unassigned_sessions` ⋈ `sessions` rows a scheduler
 * pass may launch, before its LIMIT. The platform metrics count the same
 * rows, so their queue is the one the scheduler drains.
 */
export function awaitingLaunch(db: Database, budget: SessionBudget): SQL {
  return and(
    inArray(sessions.admissionState, LAUNCHABLE_ADMISSION_STATES),
    isNull(sessions.executionRevokedAt),
    isNull(sessions.takeoverRequiredAt),
    // Before the LIMIT, so a backlog of spent sessions cannot crowd
    // out the ones that can still run, nor sessions waiting out a
    // restore backoff.
    withinBudget(budget),
    restoreRetryDue(),
    notExists(
      db
        .select({ one: sql`1` })
        .from(workerLaunches)
        .where(and(eq(workerLaunches.sessionId, sessions.id), holdsSlot())),
    ),
  ) as SQL;
}

export function createPostgresSchedulerStore(
  db: Database,
  options: PostgresSchedulerStoreOptions,
): SchedulerStore {
  const nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  const budget = {
    costUsd: options.sessionCostLimitUsd,
    tokens: options.sessionTokenLimit,
  };
  const work = createPostgresWorkerUnitOfWork(db, {
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return {
    async acquirePassLock(): Promise<PassLock | null> {
      const client = await options.connectForLock();
      // A session-level lock lives exactly as long as its connection: once
      // the socket is gone the server has let go of it, whether or not the
      // server has noticed yet. Watched from before the lock is taken, so a
      // drop right after it is not missed.
      const lost = new AbortController();
      const onError = (error: Error) => {
        lost.abort(
          new Error("Scheduler pass lock connection failed", { cause: error }),
        );
      };
      const onEnd = () => {
        lost.abort(new Error("Scheduler pass lock connection ended"));
      };
      client.on("error", onError);
      client.on("end", onEnd);
      const giveBack = (error?: Error) => {
        client.off("error", onError);
        client.off("end", onEnd);
        client.release(error);
      };
      try {
        const result = await client.query(
          `SELECT pg_try_advisory_lock(hashtext('${PASS_LOCK_KEY}')) AS locked`,
        );
        if (result.rows[0]?.locked !== true) {
          giveBack();
          return null;
        }
      } catch (error) {
        giveBack(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return {
        signal: lost.signal,
        async release() {
          let failure: Error | undefined;
          try {
            if (!lost.signal.aborted) {
              await client.query(
                `SELECT pg_advisory_unlock(hashtext('${PASS_LOCK_KEY}'))`,
              );
            }
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            throw error;
          } finally {
            // Detached only once nothing more is sent: a socket that fails
            // during the unlock still has a listener to land on. A client
            // that lost its connection, or may still hold the lock after a
            // failed unlock, is destroyed rather than handed to the next
            // caller — closing it is what makes the server let go.
            giveBack(
              failure ??
                (lost.signal.aborted
                  ? new Error("Scheduler pass lock connection lost")
                  : undefined),
            );
          }
        },
      };
    },

    async inspectDemand({ limit, excluding = [] }): Promise<SchedulerDemand> {
      const [active] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(workerLaunches)
        .where(holdsSlot());
      if (limit <= 0) {
        return {
          activeExecutionCount: active?.count ?? 0,
          eligibleSessionIds: [],
        };
      }
      const eligible = await db
        .select({ sessionId: unassignedSessions.sessionId })
        .from(unassignedSessions)
        .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
        .where(
          and(
            awaitingLaunch(db, budget),
            excluding.length === 0
              ? undefined
              : notInArray(unassignedSessions.sessionId, [...excluding]),
          ),
        )
        .orderBy(
          asc(unassignedSessions.signaledAt),
          asc(unassignedSessions.sessionId),
        )
        .limit(limit);
      return {
        activeExecutionCount: active?.count ?? 0,
        eligibleSessionIds: eligible.map((row) => row.sessionId),
      };
    },

    async reserveLaunch(
      input: ReserveLaunchInput,
    ): Promise<StoredLaunchIntent | null> {
      return db.transaction(async (tx) => {
        // One advisory lock serializes every reservation so the capacity
        // check below cannot be raced by another scheduler pass; the session
        // row lock then covers the per-session checks.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('executions:reserve_launch'))`,
        );
        const [capacity] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(workerLaunches)
          .where(holdsSlot());
        if ((capacity?.count ?? 0) >= input.slotLimit) return null;
        const [session] = await tx
          .select({
            admissionState: sessions.admissionState,
            costUsd: sessions.costUsd,
            providerTokens: sessions.providerTokens,
            executionRevokedAt: sessions.executionRevokedAt,
            takeoverRequiredAt: sessions.takeoverRequiredAt,
            partition: sessions.partition,
            restoreRetryAt: sessions.restoreRetryAt,
          })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1)
          .for("update");
        if (
          !session ||
          !LAUNCHABLE_ADMISSION_STATES.includes(session.admissionState) ||
          session.executionRevokedAt !== null ||
          session.takeoverRequiredAt !== null ||
          (session.restoreRetryAt !== null &&
            session.restoreRetryAt > (await dbNow(tx)))
        ) {
          return null;
        }
        if (budgetExceeded(session, budget)) {
          return null;
        }
        const [signal] = await tx
          .select({ sessionId: unassignedSessions.sessionId })
          .from(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, input.sessionId))
          .limit(1);
        if (!signal) return null;
        const [open] = await tx
          .select({ executionId: workerLaunches.executionId })
          .from(workerLaunches)
          .where(
            and(eq(workerLaunches.sessionId, input.sessionId), holdsSlot()),
          )
          .limit(1);
        if (open) return null;
        // Generations are per session and every reservation writes both rows
        // together, so the executions history is the whole of it.
        const [latest] = await tx
          .select({ generation: max(executions.generation) })
          .from(executions)
          .where(eq(executions.sessionId, input.sessionId));
        const intent: StoredLaunchIntent = {
          executionId: `exec-${randomUUID()}`,
          generation: (latest?.generation ?? 0) + 1,
          image: input.image,
          operationId: randomUUID(),
          resources: parseExecutionResources(input.resources),
          sessionId: input.sessionId,
        };
        await tx.insert(executions).values({
          backend: input.backend,
          createdAt: input.now,
          desiredState: DESIRED_RUNNING,
          generation: intent.generation,
          id: intent.executionId,
          launchOperationId: intent.operationId,
          observedState: "pending",
          sessionId: intent.sessionId,
        });
        // The launch is registered in the same transaction that takes the
        // slot: there is no window where capacity is spent but the worker
        // that spends it could not claim. The nonce columns stay null until
        // a container is actually created for this launch.
        await tx.insert(workerLaunches).values({
          backend: input.backend,
          createdAt: input.now,
          executionId: intent.executionId,
          generation: intent.generation,
          image: intent.image,
          partition: session.partition,
          resources: intent.resources,
          sessionId: intent.sessionId,
          slotReservedAt: input.now,
          ...(input.imageRuntime === undefined
            ? {}
            : {
                runtimeEngine: input.imageRuntime.engine,
                runtimeSdkVersion: input.imageRuntime.sdkVersion,
                runtimeCliVersion: input.imageRuntime.cliVersion,
                runtimeProfileScheme: input.imageRuntime.profileDigestScheme,
              }),
        });
        await tx
          .update(sessions)
          .set({
            executionId: intent.executionId,
            firstWorkerImage: sql`COALESCE(${sessions.firstWorkerImage}, ${intent.image})`,
            updatedAt: input.now,
          })
          .where(eq(sessions.id, input.sessionId));
        return intent;
      });
    },

    pointerRuntimeOf: (sessionId) => readPointerImageRuntime(db, sessionId),

    async workerImageRefusals(): Promise<WorkerImageRefusal[]> {
      const rows = await db.select().from(workerImageRefusals);
      return rows.map((row) => ({
        image: row.image,
        assumed: {
          engine: row.assumedEngine,
          sdkVersion: row.assumedSdkVersion,
          cliVersion: row.assumedCliVersion,
          profileDigestScheme: row.assumedProfileScheme,
        },
      }));
    },

    holdIncompatibleBeforeLaunch: (input) =>
      holdIncompatibleBeforeLaunch(db, input),

    async issueBootstrapNonce(
      ref: ExecutionRef,
      attempt?: number,
    ): Promise<string> {
      const nonce = generateLaunchNonce();
      const rotated = await db
        .update(workerLaunches)
        .set({
          nonceHash: hashWorkerToken(nonce),
          // Written on the database clock, where `claimAtomic` judges it.
          nonceExpiresAt: fromDbNow(nonceTtlMs),
        })
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            // Issuing invalidates whatever this launch held before, so it is
            // refused once a worker has traded the nonce for a binding or
            // the slot has gone back.
            isNull(workerLaunches.claimedAttemptId),
            holdsSlot(),
            attempt === undefined
              ? undefined
              : eq(workerLaunches.launchAttempts, attempt),
            // And while a failed attempt's backoff runs, or once the launch
            // was asked to go: a pass that lost its lock mid-ensure must not
            // hand a fresh credential to a launch another pass has failed or
            // given up on.
            or(
              isNull(workerLaunches.launchRetryAt),
              lte(workerLaunches.launchRetryAt, DB_NOW),
            ),
            exists(
              db
                .select({ one: sql`1` })
                .from(executions)
                .where(
                  and(
                    eq(executions.id, workerLaunches.executionId),
                    eq(executions.desiredState, DESIRED_RUNNING),
                  ),
                ),
            ),
          ),
        )
        .returning({ executionId: workerLaunches.executionId });
      if (rotated.length !== 1) {
        throw new Error(
          `Launch ${ref.executionId} generation ${ref.generation} is claimed, released, backing off, asked to go, past this attempt or unknown; no bootstrap credential was issued`,
        );
      }
      return nonce;
    },

    async revokeBootstrapNonce(ref: ExecutionRef): Promise<boolean> {
      // Clearing the hash is what shuts the door: `claimAtomic` finds a launch
      // by hash, and null matches nothing. Both statements take the same row
      // lock, so a claim commits strictly before or strictly after this — the
      // loser sees the winner's state and gives up.
      //
      // The expiry stays as it was. A teardown that fails after this leaves a
      // launch with no credential and a past expiry, which is exactly what
      // brings the next pass back here to try again.
      const revoked = await db
        .update(workerLaunches)
        .set({ nonceHash: null })
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            isNull(workerLaunches.claimedAttemptId),
            holdsSlot(),
            lte(workerLaunches.nonceExpiresAt, DB_NOW),
          ),
        )
        .returning({ executionId: workerLaunches.executionId });
      return revoked.length === 1;
    },

    async requestReplacement(
      ref: ExecutionRef,
      reason: ReplaceReason,
      expectedCount: number,
      expectedNonceFingerprint?: string | null,
    ): Promise<number | null> {
      // The fingerprint is compared inside the row lock as well, so a
      // credential issued anew since the caller read its snapshot is never
      // the one this write revokes.
      const credentialFence =
        expectedNonceFingerprint === undefined
          ? undefined
          : expectedNonceFingerprint === null
            ? isNull(workerLaunches.nonceHash)
            : sql`encode(sha256(${workerLaunches.nonceHash}), 'hex') = ${expectedNonceFingerprint}`;
      // The same guard as issuing a credential: a launch that bound a worker
      // or gave its slot back has nothing to rebuild, and saying so here is
      // what stops the caller tearing its resource down. Clearing the hash
      // is what shuts the door (see `revokeBootstrapNonce`): a claim commits
      // strictly before this row lock or finds nothing to claim after it.
      return db.transaction(async (tx) => {
        const [launch] = await tx
          .select({ executionId: workerLaunches.executionId })
          .from(workerLaunches)
          .where(
            and(
              eq(workerLaunches.executionId, ref.executionId),
              eq(workerLaunches.generation, ref.generation),
            ),
          )
          .limit(1)
          .for("update");
        if (!launch) return null;
        // Read after the row lock, in a statement of its own: a terminate
        // takes the same lock before it asks for the kill, so one that got
        // there first is seen here, and a launch asked to go is killed, not
        // rebuilt. Folded into the update below, the check would be judged
        // on the snapshot taken before the wait.
        const [execution] = await tx
          .select({ desiredState: executions.desiredState })
          .from(executions)
          .where(
            and(
              eq(executions.id, ref.executionId),
              eq(executions.generation, ref.generation),
            ),
          )
          .limit(1);
        if (execution?.desiredState !== DESIRED_RUNNING) return null;
        const [row] = await tx
          .update(workerLaunches)
          .set({
            nonceHash: null,
            replacementCount: sql`${workerLaunches.replacementCount} + 1`,
            replacementReason: reason,
          })
          .where(
            and(
              eq(workerLaunches.executionId, ref.executionId),
              eq(workerLaunches.generation, ref.generation),
              isNull(workerLaunches.claimedAttemptId),
              holdsSlot(),
              eq(workerLaunches.replacementCount, expectedCount),
              credentialFence,
            ),
          )
          .returning({ count: workerLaunches.replacementCount });
        return row?.count ?? null;
      });
    },

    async recordLaunchFailure(
      ref: ExecutionRef,
      input: LaunchFailureInput,
    ): Promise<LaunchFailureOutcome> {
      const error = input.error.slice(0, LAUNCH_ERROR_MAX_CHARS);
      const credentialFence =
        input.expectedNonceFingerprint === undefined
          ? undefined
          : input.expectedNonceFingerprint === null
            ? isNull(workerLaunches.nonceHash)
            : sql`encode(sha256(${workerLaunches.nonceHash}), 'hex') = ${input.expectedNonceFingerprint}`;
      return db.transaction(async (tx) => {
        // Launch, session, then execution: the order every other path takes
        // its locks in, so this never deadlocks against a claim or an exit.
        const [launch] = await tx
          .select({ executionId: workerLaunches.executionId })
          .from(workerLaunches)
          .where(
            and(
              eq(workerLaunches.executionId, ref.executionId),
              eq(workerLaunches.generation, ref.generation),
            ),
          )
          .limit(1)
          .for("update");
        if (!launch) return "stale";
        // After the row lock and in a statement of its own, as in
        // `requestReplacement`: a terminate that got there first is seen.
        const [execution] = await tx
          .select({ desiredState: executions.desiredState })
          .from(executions)
          .where(
            and(
              eq(executions.id, ref.executionId),
              eq(executions.generation, ref.generation),
            ),
          )
          .limit(1);
        if (execution?.desiredState !== DESIRED_RUNNING) return "stale";
        const [row] = await tx
          .update(workerLaunches)
          .set({
            launchFailureCount: sql`${workerLaunches.launchFailureCount} + 1`,
            launchAttempts: sql`${workerLaunches.launchAttempts} + 1`,
            lastLaunchError: error,
            launchRetryAt: input.quarantine
              ? null
              : fromDbNow(input.retryDelayMs),
            nonceHash: null,
            // Given up on, there is nothing left to rebuild; waiting, the
            // pending replacement is what keeps the gone resource from
            // reading as an exit.
            ...(input.quarantine ? { replacementReason: null } : {}),
          })
          .where(
            and(
              eq(workerLaunches.executionId, ref.executionId),
              eq(workerLaunches.generation, ref.generation),
              isNull(workerLaunches.claimedAttemptId),
              holdsSlot(),
              eq(workerLaunches.launchFailureCount, input.expectedCount),
              eq(workerLaunches.launchAttempts, input.expectedAttempts),
              credentialFence,
            ),
          )
          .returning({ sessionId: workerLaunches.sessionId });
        if (!row) return "stale";
        if (!input.quarantine) return "backing_off";
        await quarantineLaunch(
          tx,
          ref,
          row.sessionId,
          launchFailedCause(error),
        );
        return "quarantined";
      });
    },

    async beginLaunchAttempt(
      ref: ExecutionRef,
      expectedAttempts: number,
    ): Promise<number | null> {
      const [row] = await db
        .update(workerLaunches)
        .set({ launchAttempts: sql`${workerLaunches.launchAttempts} + 1` })
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            eq(workerLaunches.launchAttempts, expectedAttempts),
            holdsSlot(),
            // A launch asked to go since the pass read it — by a terminate,
            // or by the gateway failing its session — gets no new
            // resource.
            exists(
              db
                .select({ one: sql`1` })
                .from(executions)
                .where(
                  and(
                    eq(executions.id, workerLaunches.executionId),
                    eq(executions.desiredState, DESIRED_RUNNING),
                  ),
                ),
            ),
          ),
        )
        .returning({ attempts: workerLaunches.launchAttempts });
      return row?.attempts ?? null;
    },

    async requestDrain(
      ref: ExecutionRef,
      deadlineMs: number,
    ): Promise<DrainState | null> {
      return db.transaction(async (tx) => {
        // The launch row first, as a claim takes it, then the session a
        // worker's next-input locks before it reads the request: either the
        // turn it hands out is seen below, or it sees the request and hands
        // out nothing.
        const [launch] = await tx
          .select({ claimedAttemptId: workerLaunches.claimedAttemptId })
          .from(workerLaunches)
          .where(
            and(
              eq(workerLaunches.executionId, ref.executionId),
              eq(workerLaunches.generation, ref.generation),
              isNull(workerLaunches.slotReleasedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!launch || launch.claimedAttemptId === null) return null;
        const [execution] = await tx
          .select({ desiredState: executions.desiredState })
          .from(executions)
          .where(
            and(
              eq(executions.id, ref.executionId),
              eq(executions.generation, ref.generation),
            ),
          )
          .limit(1);
        if (execution?.desiredState !== DESIRED_RUNNING) return null;
        // The session still bound to this launch; one it let go of has no
        // turn here to wait for.
        const [session] = await tx
          .select({
            id: sessions.id,
            restoreAttemptId: sessions.restoreAttemptId,
          })
          .from(sessions)
          .where(eq(sessions.executionId, ref.executionId))
          .limit(1)
          .for("update");
        const [requested] = await tx
          .update(workerLaunches)
          .set({
            drainRequestedAt: sql`COALESCE(${workerLaunches.drainRequestedAt}, ${DB_NOW})`,
          })
          .where(eq(workerLaunches.executionId, ref.executionId))
          .returning({
            overdue: sql<boolean>`${workerLaunches.drainRequestedAt} + ${deadlineMs} * interval '1 millisecond' <= ${DB_NOW}`,
          });
        const open =
          session === undefined
            ? []
            : await tx
                .select({ id: turns.id })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, session.id),
                    inArray(turns.status, OPEN_TURN_STATUSES),
                  ),
                )
                .limit(1);
        // A worker that has not asked for input yet is still restoring or
        // starting up; cut short, it would count as a failed startup
        // . Its first poll ends that, and gets no turn.
        const startingUp =
          session !== undefined &&
          session.restoreAttemptId === launch.claimedAttemptId;
        return {
          busy: open.length > 0 || startingUp,
          overdue: requested?.overdue === true,
        };
      });
    },

    async settleReplacement(
      ref: ExecutionRef,
      expectedCount: number,
    ): Promise<void> {
      await db
        .update(workerLaunches)
        .set({ replacementReason: null })
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            // A replacement asked for since belongs to whoever asked.
            eq(workerLaunches.replacementCount, expectedCount),
          ),
        );
    },

    async bootstrapCredentialState(
      ref: ExecutionRef,
    ): Promise<LaunchCredentialState> {
      const [row] = await db
        .select({
          claimedAttemptId: workerLaunches.claimedAttemptId,
          nonceHash: workerLaunches.nonceHash,
        })
        .from(workerLaunches)
        .where(
          and(
            eq(workerLaunches.executionId, ref.executionId),
            eq(workerLaunches.generation, ref.generation),
            holdsSlot(),
          ),
        )
        .limit(1);
      if (!row) {
        throw new Error(
          `Launch ${ref.executionId} generation ${ref.generation} is released or unknown; it accepts no bootstrap credential`,
        );
      }
      if (row.claimedAttemptId !== null) return { claimed: true };
      return {
        claimed: false,
        fingerprint: row.nonceHash
          ? launchNonceFingerprint(row.nonceHash)
          : null,
      };
    },

    async listActiveExecutions(backend): Promise<ActiveExecution[]> {
      const rows = await db
        .select({
          backend: workerLaunches.backend,
          claimedAttemptId: workerLaunches.claimedAttemptId,
          desiredState: executions.desiredState,
          executionId: workerLaunches.executionId,
          generation: workerLaunches.generation,
          image: workerLaunches.image,
          launchAttempts: workerLaunches.launchAttempts,
          launchFailureCount: workerLaunches.launchFailureCount,
          launchRetryAt: workerLaunches.launchRetryAt,
          launchRetryDue: sql<boolean>`${workerLaunches.launchRetryAt} IS NULL OR ${workerLaunches.launchRetryAt} <= ${DB_NOW}`,
          nonceExpiresAt: workerLaunches.nonceExpiresAt,
          nonceExpired: sql<boolean>`${workerLaunches.nonceExpiresAt} <= ${DB_NOW}`,
          nonceHash: workerLaunches.nonceHash,
          observedAt: executions.observedAt,
          observedState: executions.observedState,
          operationId: executions.launchOperationId,
          providerRef: executions.providerRef,
          replacementCount: workerLaunches.replacementCount,
          replacementReason: workerLaunches.replacementReason,
          resources: workerLaunches.resources,
          sessionId: executions.sessionId,
        })
        .from(workerLaunches)
        // A launch with no execution row has not been claimed and was not
        // reserved here; whoever registered it owns its resource.
        .innerJoin(executions, eq(executions.id, workerLaunches.executionId))
        .where(and(holdsSlot(), eq(workerLaunches.backend, backend)))
        .orderBy(asc(workerLaunches.slotReservedAt), asc(executions.id));
      // Rows written before the intent columns existed come back with a null
      // operation id; the scheduler closes them out rather than relaunching.
      return rows.map((row) => ({
        backend: backendKindOf(row.backend),
        claimed: row.claimedAttemptId !== null,
        desiredState:
          row.desiredState === "terminated" ? "terminated" : "running",
        executionId: row.executionId,
        generation: row.generation,
        image: row.image,
        launchAttempts: row.launchAttempts,
        launchFailureCount: row.launchFailureCount,
        launchRetryAt: row.launchRetryAt,
        launchRetryDue: row.launchRetryDue === true,
        nonceExpiresAt: row.nonceExpiresAt,
        // Null while no credential was issued; the comparison yields null too.
        nonceExpired: row.nonceExpired === true,
        nonceFingerprint: row.nonceHash
          ? launchNonceFingerprint(row.nonceHash)
          : null,
        observedAt: row.observedAt,
        observedState: observedStateOf(row.observedState),
        operationId: row.operationId,
        providerRef: row.providerRef,
        pendingReplacement:
          row.replacementReason === null
            ? null
            : replaceReasonOf(row.replacementReason),
        replacementCount: row.replacementCount,
        // The CHECK keeps the two null together; a shape the scheduler
        // could not launch fails here rather than at some later create.
        resources:
          row.resources === null
            ? null
            : parseExecutionResources(row.resources),
        sessionId: row.sessionId,
      }));
    },

    async filterKnown(refs, backend): Promise<ExecutionRef[]> {
      if (refs.length === 0) return [];
      const rows = await db
        .select({
          executionId: workerLaunches.executionId,
          generation: workerLaunches.generation,
        })
        .from(workerLaunches)
        .where(
          and(
            inArray(
              workerLaunches.executionId,
              refs.map((ref) => ref.executionId),
            ),
            holdsSlot(),
            eq(workerLaunches.backend, backend),
          ),
        );
      const generations = new Map(
        rows.map((r) => [r.executionId, r.generation]),
      );
      return refs.filter(
        (ref) => generations.get(ref.executionId) === ref.generation,
      );
    },

    async filterRetainedSessions(
      sessionIds: string[],
      options: { stoppedTtlMs: number },
    ): Promise<string[]> {
      if (sessionIds.length === 0) return [];
      // Binding a non-uuid to a uuid column is an error, not a miss, and a
      // thrown query would take the whole GC step down. They are also
      // exactly the ids nothing here can judge, so they are retained.
      const unjudgeable = sessionIds.filter((id) => !UUID.test(id));
      const judgeable = sessionIds.filter((id) => UUID.test(id));
      if (judgeable.length === 0) return unjudgeable;
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            inArray(sessions.id, judgeable),
            or(
              and(
                notInArray(sessions.admissionState, FINAL_ADMISSION_STATES),
                or(
                  sql`${sessions.admissionState} <> 'stopped'`,
                  sql`${sessions.updatedAt} > ${fromDbNow(-options.stoppedTtlMs)}`,
                ),
              ),
              // A launch holds its session until `confirmExecutionGone`, so
              // that is also how long the workspace may still be mounted.
              exists(
                db
                  .select({ one: sql`1` })
                  .from(workerLaunches)
                  .where(
                    and(eq(workerLaunches.sessionId, sessions.id), holdsSlot()),
                  ),
              ),
            ),
          ),
        );
      return [...unjudgeable, ...rows.map((row) => row.id)];
    },

    async filterClosedLegacySessions(sessionIds) {
      const judgeable = sessionIds.filter((id) => UUID.test(id));
      if (judgeable.length === 0) return [];
      // `closed` is final, so no lock is needed: nothing moves a session out
      // of it, and a launch cannot reserve a slot for a closed session.
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            inArray(sessions.id, judgeable),
            inArray(sessions.admissionState, FINAL_ADMISSION_STATES),
            notExists(
              db
                .select({ one: sql`1` })
                .from(workerLaunches)
                .where(
                  and(eq(workerLaunches.sessionId, sessions.id), holdsSlot()),
                ),
            ),
          ),
        );
      return rows.map((row) => row.id);
    },

    async claimWorkspaceReclaim({ sessionId, workspaceId, stoppedTtlMs }) {
      if (!UUID.test(sessionId)) return { kind: "retained" };
      return db.transaction(async (tx) => {
        // Resume's order (`lockSessionForControl`): the bound launch first,
        // then the session. Taking them the other way round would deadlock
        // against a resume waiting on the session with the launch in hand.
        const [peek] = await tx
          .select({ executionId: sessions.executionId })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!peek) return { kind: "unclaimed" };
        if (peek.executionId !== null) {
          await tx
            .select({ executionId: workerLaunches.executionId })
            .from(workerLaunches)
            .where(eq(workerLaunches.executionId, peek.executionId))
            .limit(1)
            .for("update");
        }
        const [session] = await tx
          .select({
            admissionState: sessions.admissionState,
            executionId: sessions.executionId,
            pendingClaim: sessions.workspaceReclaimId,
            updatedAt: sessions.updatedAt,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for("update");
        // Rebound between the peek and the lock: judged again next pass.
        if (!session || session.executionId !== peek.executionId) {
          return { kind: "retained" };
        }
        const [slot] = await tx
          .select({ one: sql`1` })
          .from(workerLaunches)
          .where(and(eq(workerLaunches.sessionId, sessionId), holdsSlot()))
          .limit(1);
        if (slot) return { kind: "retained" };
        if (session.admissionState === "closed") return { kind: "unclaimed" };
        if (session.admissionState !== "stopped") return { kind: "retained" };
        // One claim at a time; a pending one is finished by the sweep.
        if (session.pendingClaim !== null) return { kind: "retained" };
        const now = await dbNow(tx);
        if (session.updatedAt.getTime() > now.getTime() - stoppedTtlMs) {
          return { kind: "retained" };
        }
        const claim = randomUUID();
        await tx
          .update(sessions)
          .set({
            workspaceReclaimClaimedAt: now,
            workspaceReclaimId: claim,
            workspaceReclaimWorkspaceId: workspaceId,
          })
          .where(eq(sessions.id, sessionId));
        return { kind: "claimed", claimId: claim };
      });
    },

    async finishWorkspaceReclaim({ sessionId, claimId: claim, outcome }) {
      // `updated_at` is left alone: it is the stop's clock, and a released
      // claim must not restart the TTL it was judged by.
      await db
        .update(sessions)
        .set({
          workspaceReclaimClaimedAt: null,
          workspaceReclaimId: null,
          workspaceReclaimWorkspaceId: null,
          ...(outcome === "removed" ? { workspaceReclaimedAt: DB_NOW } : {}),
        })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.workspaceReclaimId, claim),
          ),
        );
    },

    async listPendingWorkspaceReclaims() {
      const rows = await db
        .select({
          claim: sessions.workspaceReclaimId,
          sessionId: sessions.id,
          workspaceId: sessions.workspaceReclaimWorkspaceId,
        })
        .from(sessions)
        .where(
          and(
            isNotNull(sessions.workspaceReclaimId),
            isNotNull(sessions.workspaceReclaimWorkspaceId),
          ),
        )
        .orderBy(asc(sessions.workspaceReclaimClaimedAt));
      return rows.flatMap(({ claim, sessionId, workspaceId }) =>
        claim === null || workspaceId === null
          ? []
          : [{ claimId: claim, sessionId, workspaceId }],
      );
    },

    async recordObservation(
      ref: ExecutionRef,
      observation: ExecutionObservation,
    ): Promise<void> {
      await db
        .update(executions)
        .set({
          observedAt: observation.observedAt,
          observedState: observation.state,
          ...(observation.providerRef === null
            ? {}
            : { providerRef: observation.providerRef }),
        })
        .where(
          and(
            eq(executions.id, ref.executionId),
            eq(executions.generation, ref.generation),
          ),
        );
    },

    async confirmExecutionGone(executionId, now, incarnation, endReason) {
      const result = await work.confirmExecutionGoneAtomic({
        executionId,
        now,
        ...(incarnation === null ? {} : { incarnation }),
        ...(endReason === undefined ? {} : { endReason }),
      });
      return result.superseded
        ? "superseded"
        : result.deferred
          ? "deferred"
          : "confirmed";
    },

    async desiredStateOf(ref) {
      const [row] = await db
        .select({ desiredState: executions.desiredState })
        .from(executions)
        .where(
          and(
            eq(executions.id, ref.executionId),
            eq(executions.generation, ref.generation),
          ),
        )
        .limit(1);
      if (!row) return null;
      return row.desiredState === "terminated" ? "terminated" : "running";
    },

    markOverdueTerminations(input): Promise<number> {
      return expireOverdueTerminations(db, {
        ...input,
        limit: OVERDUE_TERMINATION_SWEEP_LIMIT,
        ...(options.logger ? { logger: options.logger } : {}),
      });
    },
  };
}

const OBSERVED_STATES = new Set<ExecutionObservation["state"]>([
  "pending",
  "running",
  "suspended",
  "terminating",
  "terminated",
  "unknown",
]);

const REPLACE_REASONS = new Set<ReplaceReason>([
  "credential_mismatch",
  "nonce_expired",
  "spec_mismatch",
  "stale_isolation",
]);

function replaceReasonOf(value: string): ReplaceReason {
  if (REPLACE_REASONS.has(value as ReplaceReason)) {
    return value as ReplaceReason;
  }
  throw new Error(
    `worker_launches.replacement_reason holds unknown value ${value}`,
  );
}

function backendKindOf(value: string): ExecutionBackendKind {
  const parsed = executionBackendSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`worker_launches.backend holds unknown value ${value}`);
  }
  return parsed.data;
}

function observedStateOf(value: string): ExecutionObservation["state"] {
  return OBSERVED_STATES.has(value as ExecutionObservation["state"])
    ? (value as ExecutionObservation["state"])
    : "unknown";
}
