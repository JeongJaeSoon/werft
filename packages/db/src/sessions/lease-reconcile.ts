import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
} from "drizzle-orm";
import { ENDED_ATTEMPT_STATES, OPEN_TURN_STATUSES } from "../control-shared.ts";
import { DB_NOW, dbNow, fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  attempts,
  controlIntents,
  executions,
  sessions,
  turns,
  workerCredentials,
  workerLaunches,
  workers,
} from "../schema.ts";

export type ReconciledLease = {
  attemptId: string;
  dryRun: boolean;
  executionId: string;
  executionGeneration: number;
  sessionId: string;
  /**
   * `fenced`: the session still pointed at this execution, so its epoch
   * moved on and the kill was requested. `ended`: the session had already
   * moved on (a release or a confirmed exit beat this pass), so only the
   * attempt row was closed.
   */
  action: "fenced" | "ended";
};

/**
 * Expiry is judged on the database clock, like every fence in the gateway;
 * `now` only stamps the audit columns of what this pass ended.
 *
 * architecture.md § lease 만료와 실행 결과 판정, row "execution 종료 미확인":
 * an attempt whose lease ran out loses the session — its epoch is discarded
 * so nothing it still sends can commit, and its execution is asked to go —
 * but nothing else is decided here. Whether its delivered turn is
 * `outcome_unknown` or its queued input can run again is judged once, in
 * confirmExecutionGoneAtomic, after the backend has seen the resource gone;
 * the slot stays taken until then. A silent worker is not evidence that the
 * container stopped.
 */
export async function reconcileExpiredLeases(
  db: Database,
  options: { dryRun?: boolean; limit?: number; now?: Date },
): Promise<ReconciledLease[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  // Candidates are read without locks; each is re-read under the row locks
  // below, in the order every gateway path takes them (launch, session,
  // attempt, execution), so a heartbeat that lands in between wins cleanly.
  const candidates = await db
    .select({
      id: attempts.id,
      executionId: attempts.executionId,
      sessionId: attempts.sessionId,
    })
    .from(attempts)
    .where(
      and(
        notInArray(attempts.state, ENDED_ATTEMPT_STATES),
        lt(attempts.leaseExpiresAt, DB_NOW),
      ),
    )
    .orderBy(asc(attempts.leaseExpiresAt), asc(attempts.id))
    .limit(limit);

  const reconciled: ReconciledLease[] = [];
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      await tx
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, candidate.executionId))
        .limit(1)
        .for("update");
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, candidate.sessionId))
        .limit(1)
        .for("update");
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(eq(attempts.id, candidate.id))
        .limit(1)
        .for("update");
      if (!session || !attempt) return null;
      // Read after the locks: a heartbeat that held the attempt row may
      // have just extended the lease past this instant.
      const at = await dbNow(tx);
      const live =
        !ENDED_ATTEMPT_STATES.includes(attempt.state) &&
        attempt.leaseExpiresAt.getTime() < at.getTime();
      if (!live) return null;
      const owns =
        session.executionId === attempt.executionId &&
        session.leaseEpoch === attempt.leaseEpoch;
      const result: ReconciledLease = {
        action: owns ? "fenced" : "ended",
        attemptId: attempt.id,
        dryRun,
        executionId: attempt.executionId,
        executionGeneration: attempt.executionGeneration,
        sessionId: attempt.sessionId,
      };
      if (dryRun) return result;

      await tx
        .update(attempts)
        .set({ state: "lost", endedAt: now, endReason: "lease_expired" })
        .where(eq(attempts.id, attempt.id));
      await tx
        .update(workerCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(workerCredentials.attemptId, attempt.id),
            isNull(workerCredentials.revokedAt),
          ),
        );
      await tx.delete(workers).where(eq(workers.podId, attempt.executionId));
      if (owns) {
        await fenceAndRequestKill(tx, {
          sessionId: session.id,
          leaseEpoch: session.leaseEpoch,
          executionId: attempt.executionId,
          now,
        });
      }
      return result;
    });
    if (outcome) reconciled.push(outcome);
  }
  return reconciled;
}

/**
 * The same two writes a terminate makes: fence the old worker, then ask for
 * its generation to be removed. pod_id/execution_id stay so no new claim can
 * start until the removal is confirmed. The caller holds the session row.
 */
async function fenceAndRequestKill(
  tx: Database,
  input: {
    sessionId: string;
    leaseEpoch: number;
    executionId: string;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(sessions)
    .set({ leaseEpoch: input.leaseEpoch + 1, updatedAt: input.now })
    .where(eq(sessions.id, input.sessionId));
  await tx
    .update(executions)
    .set({ desiredState: "terminated" })
    .where(eq(executions.id, input.executionId));
}

export type ReconciledInterrupt = {
  attemptId: string;
  dryRun: boolean;
  executionId: string;
  sessionId: string;
};

/**
 * an interrupt is settled only by the transaction that gives its
 * turn a terminal. A worker whose finalize retries forever, whose event flush
 * hangs, or whose exit is never confirmed keeps heartbeating, so the lease
 * sweep above never takes it and the receipt would stay `accepted` for good.
 * One still open past `deadlineMs` sends its attempt down the terminate path
 * instead; confirmExecutionGoneAtomic then ends the turn `outcome_unknown`
 * and settles the receipt `unknown`, as for any execution that went away.
 *
 * The attempt row is left as it is, as a terminate leaves it: the epoch alone
 * fences the worker, and the removal, once observed, closes the attempt.
 */
export async function reconcileOverdueInterrupts(
  db: Database,
  options: { deadlineMs: number; dryRun?: boolean; limit?: number; now?: Date },
): Promise<ReconciledInterrupt[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const overdue = (attemptId?: string) =>
    and(
      eq(controlIntents.kind, "interrupt"),
      isNull(controlIntents.settledAt),
      // issued_at is stamped by the database clock, so the deadline is
      // measured on it too.
      lte(controlIntents.issuedAt, fromDbNow(-options.deadlineMs)),
      attemptId === undefined
        ? undefined
        : eq(controlIntents.attemptId, attemptId),
      // Only a turn still open is one the kill settles; the attempt check
      // keeps an intent on a turn some other attempt now runs out of it.
      eq(turns.attemptId, controlIntents.attemptId),
      inArray(turns.status, OPEN_TURN_STATUSES),
    );

  const candidates = await db
    .selectDistinct({
      id: attempts.id,
      executionId: attempts.executionId,
      sessionId: attempts.sessionId,
    })
    .from(controlIntents)
    .innerJoin(turns, eq(turns.id, controlIntents.targetTurnId))
    .innerJoin(attempts, eq(attempts.id, controlIntents.attemptId))
    // The skips below, applied here too so attempts already dealt with do
    // not fill every batch and starve the ones still owed a kill.
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, attempts.sessionId),
        eq(sessions.executionId, attempts.executionId),
        eq(sessions.leaseEpoch, attempts.leaseEpoch),
      ),
    )
    .innerJoin(executions, eq(executions.id, attempts.executionId))
    .where(
      and(
        overdue(),
        notInArray(attempts.state, ENDED_ATTEMPT_STATES),
        ne(executions.desiredState, "terminated"),
      ),
    )
    .orderBy(asc(attempts.id))
    .limit(limit);

  const reconciled: ReconciledInterrupt[] = [];
  for (const candidate of candidates) {
    const outcome = await db.transaction(async (tx) => {
      // Lock order of every gateway path: launch, session, attempt,
      // execution. A finalize that settles the interrupt meanwhile wins.
      await tx
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, candidate.executionId))
        .limit(1)
        .for("update");
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, candidate.sessionId))
        .limit(1)
        .for("update");
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(eq(attempts.id, candidate.id))
        .limit(1)
        .for("update");
      const [execution] = await tx
        .select({ desiredState: executions.desiredState })
        .from(executions)
        .where(eq(executions.id, candidate.executionId))
        .limit(1)
        .for("update");
      if (!session || !attempt || !execution) return null;
      if (ENDED_ATTEMPT_STATES.includes(attempt.state)) return null;
      // A session that moved on already fenced this attempt, and a kill
      // already asked for is waiting on the scheduler: writing again would
      // only move the epoch on every pass.
      const owns =
        session.executionId === attempt.executionId &&
        session.leaseEpoch === attempt.leaseEpoch;
      if (!owns || execution.desiredState === "terminated") return null;
      const [still] = await tx
        .select({ id: controlIntents.id })
        .from(controlIntents)
        .innerJoin(turns, eq(turns.id, controlIntents.targetTurnId))
        .where(overdue(attempt.id))
        .limit(1);
      if (!still) return null;
      const result: ReconciledInterrupt = {
        attemptId: attempt.id,
        dryRun,
        executionId: attempt.executionId,
        sessionId: attempt.sessionId,
      };
      if (dryRun) return result;
      await fenceAndRequestKill(tx, {
        sessionId: session.id,
        leaseEpoch: session.leaseEpoch,
        executionId: attempt.executionId,
        now,
      });
      return result;
    });
    if (outcome) reconciled.push(outcome);
  }
  return reconciled;
}
