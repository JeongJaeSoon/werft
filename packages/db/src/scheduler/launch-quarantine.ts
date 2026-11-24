import type { ApiErrorCode, EnvRefusal } from "@werft-ai/contracts";
import type { ExecutionRef } from "@werft-ai/platform";
import { and, eq, inArray, sql } from "drizzle-orm";
import { INPUT_RECEIPT_OPERATIONS } from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { failResume, returnResumeToPaused } from "../resume-control.ts";
import {
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "../schema.ts";
import { recordStatus } from "../sessions/index.ts";

/** Why a launch was given up on, as the session's reader will see it. */
export type LaunchGiveUpCause = {
  /** On the failed receipts and the status event. */
  code: Extract<
    ApiErrorCode,
    "LAUNCH_FAILED" | "CATALOG_MISMATCH" | "VARIABLE_UNRESOLVED" | "NO_CAPACITY"
  >;
  /** On the failed turns. */
  terminalReason:
    | "launch_failed"
    | "catalog_mismatch"
    | "variables_refused"
    | "no_capacity";
  /** The receipt's error message, before the detail. */
  receiptPrefix: string;
  /** The resume receipt's error message, before the detail. */
  resumePrefix: string;
  /** What went wrong, as the operator will read it. */
  detail: string;
};

export function launchFailedCause(detail: string): LaunchGiveUpCause {
  return {
    code: "LAUNCH_FAILED",
    terminalReason: "launch_failed",
    receiptPrefix: "no worker could be launched for this input",
    resumePrefix: "no worker could be launched to restore the checkpoint",
    detail,
  };
}

export function catalogMismatchCause(detail: string): LaunchGiveUpCause {
  return {
    code: "CATALOG_MISMATCH",
    terminalReason: "catalog_mismatch",
    receiptPrefix:
      "the catalog no longer holds this session's connection, model or repository",
    resumePrefix:
      "the catalog no longer holds this session's connection, model or repository, so no worker may restore it",
    detail,
  };
}

/** No node had room for the worker; `detail` is how long it waited. */
export function noCapacityCause(detail: string): LaunchGiveUpCause {
  return {
    code: "NO_CAPACITY",
    terminalReason: "no_capacity",
    receiptPrefix: "no node had room to start a worker for this input",
    resumePrefix:
      "no node had room to start a worker to restore the checkpoint",
    detail,
  };
}

/** The cause names the reason, never the variable: its reader is the requester. */
export function variablesRefusedCause(reason: EnvRefusal): LaunchGiveUpCause {
  return {
    code: "VARIABLE_UNRESOLVED",
    terminalReason: "variables_refused",
    receiptPrefix:
      "a variable the agent's card declares did not reach the session",
    resumePrefix:
      "a variable the agent's card declares did not reach the session, so no worker may restore it",
    detail: `variables refused (${reason})`,
  };
}

/**
 * Gives a launch up, inside the caller's transaction and after its launch
 * row lock. Writes the kill intent — the pass carries it out and
 * `confirmExecutionGone` gives the slot back — and fails what was queued for
 * the session so far, the way a terminate cancels it: the turns, their queue
 * rows (a terminal head would block delivery), and their input receipts.
 * The session is left `failed` and unsignalled, still admitting input: the
 * next message signals it again and gets a fresh launch. A resuming session
 * goes to an operator instead, its resume failed.
 */
export async function quarantineLaunch(
  tx: Database,
  ref: ExecutionRef,
  sessionId: string | null,
  cause: LaunchGiveUpCause,
): Promise<void> {
  const [session] =
    sessionId === null
      ? []
      : await tx
          .select({
            admissionState: sessions.admissionState,
            id: sessions.id,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for("update");
  // Read after the locks, so the failure's timestamps are no earlier than
  // anything the input they fail was accepted at.
  const now = await dbNow(tx);
  // A resume that cannot get a worker at all fails as a resume
  // its receipt closes and an operator decides, with the queued input kept
  // for whatever that decision resumes.
  if (session?.admissionState === "resuming") {
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.id));
    await failResume(tx, {
      sessionId: session.id,
      error: {
        code: cause.code,
        message: `${cause.resumePrefix}: ${cause.detail}`,
      },
      now,
    });
  } else if (session) {
    const failed = await failQueuedInput(tx, session.id, cause, now);
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.id));
    if (session.admissionState !== "closed") {
      await tx
        .update(sessions)
        .set({ status: "failed", updatedAt: now })
        .where(eq(sessions.id, session.id));
      await recordStatus(tx, {
        sessionId: session.id,
        phase: "failed",
        extra: {
          admission_state: session.admissionState,
          code: cause.code,
          message: cause.detail,
          failed_turn_count: failed,
        },
        turnRowId: null,
        now,
      });
    }
  }
  await killLaunch(tx, ref);
}

/**
 * Gives a launch up after it waited too long for room, inside the caller's
 * transaction and after its launch row lock. Unlike `quarantineLaunch` the
 * session is not failed: its queued input fails with `NO_CAPACITY` and it is
 * left without a worker, waiting for its next input as after an idle worker
 * ended. That input signals it again and gets a fresh launch. A resuming
 * session goes back to paused with its checkpoint, never to an operator.
 */
export async function releaseForCapacity(
  tx: Database,
  ref: ExecutionRef,
  sessionId: string | null,
  cause: LaunchGiveUpCause,
): Promise<void> {
  const [session] =
    sessionId === null
      ? []
      : await tx
          .select({
            admissionState: sessions.admissionState,
            id: sessions.id,
            status: sessions.status,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1)
          .for("update");
  if (session) {
    const now = await dbNow(tx);
    const failed = await failQueuedInput(tx, session.id, cause, now);
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, session.id));
    const resuming = session.admissionState === "resuming";
    if (resuming) {
      await returnResumeToPaused(tx, {
        sessionId: session.id,
        error: {
          code: cause.code,
          message: `${cause.resumePrefix}: ${cause.detail}`,
        },
        now,
      });
    }
    const status = session.status === "queued" ? "idle" : session.status;
    if (resuming || status !== session.status) {
      await tx
        .update(sessions)
        .set({ status, updatedAt: now })
        .where(eq(sessions.id, session.id));
      await recordStatus(tx, {
        sessionId: session.id,
        phase: status,
        extra: {
          admission_state: resuming ? "paused" : session.admissionState,
          code: cause.code,
          message: cause.detail,
          failed_turn_count: failed,
        },
        turnRowId: null,
        now,
      });
    }
  }
  await killLaunch(tx, ref);
}

/**
 * Fails what was queued for the session so far, the way a terminate cancels
 * it: the turns, their queue rows (a terminal head would block delivery),
 * and their input receipts. Returns how many turns failed.
 */
async function failQueuedInput(
  tx: Database,
  sessionId: string,
  cause: LaunchGiveUpCause,
  now: Date,
): Promise<number> {
  const failed = await tx
    .update(turns)
    .set({
      status: "failed",
      endedAt: now,
      terminalReason: cause.terminalReason,
    })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")))
    .returning({ id: turns.id, sequence: turns.sequence });
  if (failed.length > 0) {
    await tx.delete(queueMessages).where(
      inArray(
        queueMessages.turnId,
        failed.map((turn) => turn.id),
      ),
    );
    await tx
      .update(receipts)
      .set({
        status: "failed",
        error: {
          code: cause.code,
          message: `${cause.receiptPrefix}: ${cause.detail}`,
        },
        // `result` stays the acceptance response (receiptSchema.result).
        updatedAt: now,
      })
      .where(
        and(
          inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
          eq(receipts.status, "accepted"),
          sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
          inArray(
            sql`${receipts.targetRef}->>'turn_id'`,
            failed.map((turn) => String(turn.sequence)),
          ),
        ),
      );
  }
  return failed.length;
}

/** The kill intent: the pass carries it out and the slot comes back. */
async function killLaunch(tx: Database, ref: ExecutionRef): Promise<void> {
  await tx
    .update(executions)
    .set({ desiredState: "terminated" })
    .where(
      and(
        eq(executions.id, ref.executionId),
        eq(executions.generation, ref.generation),
      ),
    );
}
