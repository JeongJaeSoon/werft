import { randomUUID } from "node:crypto";
import type { AdmissionState } from "@werft-ai/contracts";
import { publicStatus } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  controlClock,
  liveDrainer,
  lockSessionForControl,
  transactionWithBindingRetry,
} from "../control-shared.ts";
import { stopExecution, stoppedAdmission } from "../control-unit-of-work.ts";
import { sessionHoldsSource } from "../conversations/index.ts";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { queuedTurnCount } from "../resume-control.ts";
import { receipts, sessions } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { PAUSE } from "./drain.ts";
import { openPauseReceipt } from "./pause-control.ts";
import { awaitingInputAt } from "./pending-status.ts";
import { recordEvent, recordStatus } from "./session-events.ts";

export const SOURCE_DELETED = "source_deleted";

/** A deleted Slack message: the place a delete mark names. */
export type DeletedSource = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  ts: string;
};

/**
 * Stops every session of the workspace that a turn ties to the deleted
 * message and that is not stopped for a deleted source yet, one transaction
 * each (stopOnDeletedSource). Run after the delete mark commits, and again
 * on its redelivery: a session already stopped is left alone. Returns the
 * sessions it stopped.
 */
export async function stopSessionsOnDeletedSource(
  db: Database,
  source: DeletedSource,
  now: Date = new Date(),
): Promise<string[]> {
  const held = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT s.id::text AS id FROM sessions s
      WHERE s.workspace_id = ${source.workspaceId}::uuid
        AND s.source_deleted_at IS NULL
        AND s.admission_state NOT IN ('closing', 'closed')
        AND ${sessionHoldsSource(sql.raw("s.id"), source)}
      ORDER BY s.id`),
  );
  const stopped: string[] = [];
  for (const { id } of held) {
    if (
      (await stopOnDeletedSource(db, { sessionId: id, source, now })) !== null
    ) {
      stopped.push(id);
    }
  }
  return stopped;
}

/**
 * Where a session goes when a source of one of its turns is deleted, from
 * where it is. Nothing running is cut: a live worker drains as for a pause,
 * finishing the turn it holds, and the session settles paused. A park
 * becomes that plain pause, so no answer resumes it. Anything else keeps
 * its admission: nothing runs there, and source_deleted_at holds it, since
 * resume, start_fresh, retry_restore, a message, a claim and a turn's
 * delivery all refuse while it is set. So is a legacy pod binding, which
 * has no drain. Closing and closed are left as they are.
 */
export function sourceDeletedTransition(session: {
  admissionState: AdmissionState;
  pauseReason: string | null;
  legacy: boolean;
  bound: boolean;
  drainer: boolean;
}): { into: AdmissionState; pauseReceipt: "open" | "settled" | null } | null {
  const from = session.admissionState;
  if (from === "closing" || from === "closed") return null;
  if (session.legacy) return { into: from, pauseReceipt: null };
  if (session.pauseReason === "awaiting_input") {
    // The park's receipt is superseded by a pause the worker drains; a
    // paused park has no receipt open.
    return { into: from, pauseReceipt: from === "pausing" ? "open" : null };
  }
  // A resume runs no turn until its worker reports ready, so there is
  // nothing to finish: it stops as a terminate stops it, and the resume's
  // receipt is superseded.
  if (from === "resuming") {
    return { into: session.bound ? "stopping" : "stopped", pauseReceipt: null };
  }
  if (from !== "active") return { into: from, pauseReceipt: null };
  if (session.drainer) return { into: "pausing", pauseReceipt: "open" };
  // A binding with no worker draining it gets the stop intent and settles
  // paused once its execution is seen gone, as a person's pause does.
  return session.bound
    ? { into: "pausing", pauseReceipt: "open" }
    : { into: "paused", pauseReceipt: "settled" };
}

/**
 * Stops one session for a deleted source (sourceDeletedTransition) and
 * records why: the `source_deleted` system event names the message, and
 * a status event the admission it moved to. Null when the session was
 * gone, ended, or stopped for a deleted source already.
 */
export function stopOnDeletedSource(
  db: Database,
  input: { sessionId: string; source: DeletedSource; now: Date },
): Promise<AdmissionState | null> {
  const startedAt = Date.now();
  return transactionWithBindingRetry(db, async (tx, attempt) => {
    const session = await lockSessionForControl(tx, {
      sessionId: input.sessionId,
      attempt,
    });
    if (!session || session.sourceDeletedAt !== null) return null;
    const drainer =
      session.admissionState === "active"
        ? await liveDrainer(tx, session.executionId)
        : undefined;
    const transition = sourceDeletedTransition({
      admissionState: session.admissionState,
      pauseReason: session.pauseReason,
      legacy: session.executionId === null && session.podId !== null,
      bound: session.executionId !== null,
      drainer: drainer !== undefined,
    });
    if (transition === null) return null;
    const now = controlClock(input.now, startedAt);
    const { into } = transition;
    const stopped =
      session.admissionState === "resuming"
        ? await stopExecution(tx, session, { now, by: "source deletion" })
        : null;
    const stopIntent =
      session.admissionState === "active" &&
      into === "pausing" &&
      drainer === undefined;
    if (stopIntent && session.executionId !== null) {
      // As pauseAtomic writes it for a binding nothing drains; the launch
      // row is locked (lockSessionForControl).
      await tx.execute(sql`
        UPDATE executions SET desired_state = 'terminated'
        WHERE id = ${session.executionId}`);
      await tx.execute(sql`
        UPDATE worker_launches SET replacement_reason = NULL
        WHERE execution_id = ${session.executionId}`);
    }
    if (session.pauseReason === "awaiting_input" && into === "pausing") {
      await tx
        .update(receipts)
        .set({
          status: "failed",
          error: {
            code: "CONTROL_SUPERSEDED",
            message: "superseded by a deleted source before the park completed",
          },
          updatedAt: now,
        })
        .where(openPauseReceipt(session.id));
    }
    await tx
      .update(sessions)
      .set({
        revision: sql`${sessions.revision} + 1`,
        ...(stopIntent || stopped !== null
          ? { leaseEpoch: sql`${sessions.leaseEpoch} + 1` }
          : {}),
        ...(stopped === null
          ? { admissionState: into }
          : stoppedAdmission(session, stopped.pendingKill)),
        pauseReason: null,
        sourceDeletedAt: now,
        updatedAt: now,
      })
      .where(sql`${sessions.id} = ${session.id}`);
    if (transition.pauseReceipt !== null) {
      // The platform's pause, as openSystemPark writes its own: no person
      // asked, so the receipt has no actor. pendingControl hands the
      // draining worker a pause, never a park, now that pause_reason is
      // clear.
      const settled = transition.pauseReceipt === "settled";
      await tx.insert(receipts).values({
        id: randomUUID(),
        ownerId: session.ownerId,
        actor: null,
        requestId: null,
        operation: PAUSE,
        targetRef: { session_id: session.id, turn_id: null, request_id: null },
        status: settled ? "succeeded" : "accepted",
        result: settled
          ? {
              resulting_admission_state: "paused",
              checkpoint_revision:
                session.checkpointFallbackRevision ??
                session.checkpointRevision,
              queued_turn_count: await queuedTurnCount(tx, session.id),
            }
          : null,
        createdAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      });
    }
    if (into !== session.admissionState) {
      await recordStatus(tx, {
        sessionId: session.id,
        phase: publicStatus(
          into === "stopped" ? "stopped" : session.status,
          await awaitingInputAt(tx, session.id, await dbNow(tx)),
        ),
        extra: { admission_state: into, reason: SOURCE_DELETED },
        turnRowId: null,
        now,
      });
    }
    await recordEvent(tx, {
      sessionId: session.id,
      type: "system",
      payload: {
        type: "system",
        subtype: SOURCE_DELETED,
        source: {
          team_id: input.source.teamId,
          channel_id: input.source.channelId,
          ts: input.source.ts,
        },
        from_admission_state: session.admissionState,
        admission_state: into,
      },
      turnRowId: null,
      now,
    });
    return into;
  });
}
