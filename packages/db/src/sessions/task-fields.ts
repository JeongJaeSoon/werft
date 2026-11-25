import {
  type TaskClosedReason,
  type TaskClosing,
  type TaskInterpretation,
  type TaskRequest,
  taskClosedReasonSchema,
  taskClosingSchema,
  taskInterpretationSchema,
  taskRequestSchema,
} from "@werft-ai/contracts";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { sessions } from "../schema.ts";

/** A session's task fields; each null on a session that is not a task. */
export type TaskFields = {
  request: TaskRequest | null;
  interpretation: TaskInterpretation | null;
  closing: TaskClosing | null;
  closedReason: TaskClosedReason | null;
};

/**
 * Opens a session as a task with the server's part of it: the requester's
 * message and the closing rules in force now. Written once; returns false
 * when the session is missing or already has them.
 */
export async function openTaskFields(
  db: Database,
  sessionId: string,
  fields: { request: TaskRequest; closing: TaskClosing },
): Promise<boolean> {
  const request = taskRequestSchema.parse(fields.request);
  const closing = taskClosingSchema.parse(fields.closing);
  const written = await db
    .update(sessions)
    .set({ taskRequest: request, taskClosing: closing })
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.taskRequest),
        isNull(sessions.taskClosing),
      ),
    )
    .returning({ id: sessions.id });
  return written.length > 0;
}

/**
 * Records what the model made of the request. Takes the interpretation
 * alone: nothing the model returns reaches the requester's text, and a
 * result carrying more than the interpretation is refused. Written once;
 * returns false when the session is missing or already has one.
 */
export async function recordTaskInterpretation(
  db: Database,
  sessionId: string,
  interpretation: TaskInterpretation,
): Promise<boolean> {
  const parsed = taskInterpretationSchema.parse(interpretation);
  const written = await db
    .update(sessions)
    .set({ taskInterpretation: parsed })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.taskInterpretation)))
    .returning({ id: sessions.id });
  return written.length > 0;
}

/**
 * Records why the task closed, on a session already closing or closed. The
 * first reason stays; returns false when the session is missing, not
 * closing, or has one.
 */
export async function recordTaskClosedReason(
  db: Database,
  sessionId: string,
  reason: TaskClosedReason,
): Promise<boolean> {
  const parsed = taskClosedReasonSchema.parse(reason);
  const written = await db
    .update(sessions)
    .set({ taskClosedReason: parsed })
    .where(
      and(
        eq(sessions.id, sessionId),
        isNull(sessions.taskClosedReason),
        inArray(sessions.admissionState, ["closing", "closed"]),
      ),
    )
    .returning({ id: sessions.id });
  return written.length > 0;
}

/** The session's task fields, or null when there is no such session. */
export async function readTaskFields(
  db: Database,
  sessionId: string,
): Promise<TaskFields | null> {
  const [row] = await db
    .select({
      request: sessions.taskRequest,
      interpretation: sessions.taskInterpretation,
      closing: sessions.taskClosing,
      closedReason: sessions.taskClosedReason,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;
  return {
    request: taskRequestSchema.nullable().parse(row.request),
    interpretation: taskInterpretationSchema
      .nullable()
      .parse(row.interpretation),
    closing: taskClosingSchema.nullable().parse(row.closing),
    closedReason: taskClosedReasonSchema.nullable().parse(row.closedReason),
  };
}
