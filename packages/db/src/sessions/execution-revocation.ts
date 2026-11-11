import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  controlClock,
  earliestUnknownTurn,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "../control-shared.ts";
import {
  announceStopped,
  REVOKE_EXECUTION,
  stopExecution,
  stoppedAdmission,
  terminateReceiptResult,
} from "../control-unit-of-work.ts";
import type { Database } from "../queries.ts";
import { attempts, receipts, sessions, workerCredentials } from "../schema.ts";
import { recordEvent } from "./session-events.ts";

export const EXECUTION_REVOKED = "execution_revoked";
export const EXECUTION_RESTORED = "execution_restored";

export type RevokeExecutionResult =
  | {
      outcome: "revoked";
      ownerId: string;
      receiptId: string;
      receiptStatus: "accepted" | "succeeded";
      authRevision: number;
      executionId: string | null;
      revokedCredentials: number;
    }
  | { outcome: "already_revoked"; revokedAt: Date; reason: string }
  | { outcome: "not_found" }
  // Nothing runs on a closed session, and nothing reopens it.
  | { outcome: "closed" }
  // Legacy pod binding: no kill outbox and no epoch its worker honours.
  | { outcome: "unsupported" };

/**
 * architecture.md § 실행 권한 회수와 API key 회수: the operator's execution
 * Grant revocation for one session. In one transaction it moves the auth
 * revision and the lease epoch on (every fenced write of the current binding
 * fails from here, whatever it authenticated with), revokes the session's
 * worker tokens (its next request is 401), records the bound generation's
 * kill intent with everything terminate writes, and blocks dispatch until
 * the operator restores it. It does not disable the owner or touch any other
 * session, and it does not claim the worker stopped: the receipt stays
 * `accepted` until the execution is observed gone and goes `unknown` past
 * the terminate deadline, as a terminate's does.
 *
 * Lock order is launch, then session (lockSessionForControl), the order of
 * every gateway path: a finalize or heartbeat that took the session lock
 * first commits and is then fenced out with the rest; one that waits on it
 * fails its fence.
 */
export async function revokeExecutionAtomic(
  db: Database,
  input: { sessionId: string; reason: string; now: Date },
): Promise<RevokeExecutionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const reason = input.reason.trim();
  if (!reason) throw new Error("a revocation needs a reason");
  const startedAt = Date.now();
  return transactionWithBindingRetry(db, async (tx, attempt) => {
    const session = await lockSessionForControl(tx, { sessionId, attempt });
    if (!session) return { outcome: "not_found" };
    if (session.executionRevokedAt !== null) {
      return {
        outcome: "already_revoked",
        revokedAt: session.executionRevokedAt,
        reason: session.executionRevokedReason ?? "",
      };
    }
    if (session.admissionState === "closed") return { outcome: "closed" };
    if (session.executionId === null && session.podId !== null) {
      return { outcome: "unsupported" };
    }
    const now = controlClock(input.now, startedAt);

    const { pendingKill, inputWait } = await stopExecution(tx, session, {
      now,
      by: "execution revocation",
    });
    // Every token any attempt of this session still holds, not only the
    // bound one's: a token of an attempt that already ended cannot write,
    // but nothing it could still authenticate for is left standing.
    const revoked = await tx
      .update(workerCredentials)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(workerCredentials.revokedAt),
          inArray(
            workerCredentials.attemptId,
            tx
              .select({ id: attempts.id })
              .from(attempts)
              .where(eq(attempts.sessionId, sessionId)),
          ),
        ),
      )
      .returning({ attemptId: workerCredentials.attemptId });
    const into = stoppedAdmission(session, pendingKill);
    const [after] = await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
        authRevision: sql`${sessions.authRevision} + 1`,
        executionRevokedAt: now,
        executionRevokedReason: reason,
        updatedAt: now,
        ...into,
      })
      .where(eq(sessions.id, sessionId))
      .returning({ authRevision: sessions.authRevision });
    if (!after) throw new Error(`Session ${sessionId} vanished mid-revocation`);
    await announceStopped(tx, {
      session,
      into,
      inputWait,
      extra: { actor: { kind: "operator" } },
      now,
    });

    const receiptId = randomUUID();
    const receiptStatus = pendingKill ? "accepted" : "succeeded";
    await tx.insert(receipts).values({
      id: receiptId,
      // The owner's receipt list is where the owner learns why the session
      // stopped; the operator is named on the audit event.
      ownerId: session.ownerId,
      operation: REVOKE_EXECUTION,
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: receiptStatus,
      result: pendingKill
        ? null
        : terminateReceiptResult({
            checkpointRevision: session.checkpointRevision,
            unconfirmedTurnId: await earliestUnknownTurn(tx, sessionId),
          }),
      // Same as terminate: the deadline counts from durable acceptance.
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
    await recordEvent(tx, {
      sessionId,
      type: "system",
      payload: {
        type: "system",
        subtype: EXECUTION_REVOKED,
        reason,
        actor: { kind: "operator" },
        auth_revision: after.authRevision,
        execution_id: session.executionId,
        receipt_id: receiptId,
      },
      turnRowId: null,
      now,
    });
    return {
      outcome: "revoked",
      ownerId: session.ownerId,
      receiptId,
      receiptStatus,
      authRevision: after.authRevision,
      executionId: session.executionId,
      revokedCredentials: revoked.length,
    };
  });
}

export type RestoreExecutionResult =
  | { outcome: "restored"; ownerId: string }
  | { outcome: "not_revoked" }
  | { outcome: "not_found" }
  // The revoked execution has not been observed gone yet.
  | { outcome: "execution_unconfirmed"; executionId: string };

/**
 * Lifts a revocation. Nothing else is undone: the auth revision stays where
 * the revocation moved it, revoked tokens stay revoked, and the session keeps
 * the admission state it reached (stopped, or recovery_required); the owner
 * resumes it, or an operator decides its recovery, as after a terminate.
 * Refused while the revoked execution may still be running, so a restore
 * cannot overlap the generation it was meant to stop.
 */
export async function restoreExecutionAtomic(
  db: Database,
  input: { sessionId: string; reason: string; now: Date },
): Promise<RestoreExecutionResult> {
  const sessionId = input.sessionId.toLowerCase();
  const reason = input.reason.trim();
  if (!reason) throw new Error("a restore needs a reason");
  const startedAt = Date.now();
  return transactionWithBindingRetry(db, async (tx, attempt) => {
    const session = await lockSessionForControl(tx, { sessionId, attempt });
    if (!session) return { outcome: "not_found" };
    if (session.executionRevokedAt === null) return { outcome: "not_revoked" };
    if (session.executionId !== null) {
      return {
        outcome: "execution_unconfirmed",
        executionId: session.executionId,
      };
    }
    const now = controlClock(input.now, startedAt);
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        executionRevokedAt: null,
        executionRevokedReason: null,
        updatedAt: now,
      })
      .where(eq(sessions.id, sessionId));
    await recordEvent(tx, {
      sessionId,
      type: "system",
      payload: {
        type: "system",
        subtype: EXECUTION_RESTORED,
        reason,
        actor: { kind: "operator" },
      },
      turnRowId: null,
      now,
    });
    return { outcome: "restored", ownerId: session.ownerId };
  });
}
