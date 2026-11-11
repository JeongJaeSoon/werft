import {
  type InputWaitEventData,
  inputWaitEventDataSchema,
  type SessionEventName,
  type StatusEventPhase,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import { and, desc, eq, lt, notExists, sql } from "drizzle-orm";
import type { ControlStageMeasure } from "../control-shared.ts";
import { dbNow } from "../db-clock.ts";
import {
  actionableOfSession,
  awaitingInputAt,
  publicStatus,
} from "../decision/pending-requests.ts";
import type { Database } from "../queries.ts";
import { events, sessionEventArchives, sessions } from "../schema.ts";

/**
 * The `occurred_at` readers see on the session's last event, or on the last
 * one before `beforeId`. Each writer stamps its own clock — the worker when
 * it publishes, the control plane when it commits — and a worker frame held
 * behind its turn's finalize is stored after a status stamped later, so every
 * write is raised to at least this: in id order the times never go back.
 */
export async function streamClock(
  tx: Database,
  sessionId: string,
  beforeId?: number,
): Promise<Date | null> {
  const [row] = await tx
    .select({
      // Rounded up: readers round a sub-millisecond created_at to the
      // nearest millisecond, and a truncated floor could sit below it.
      epochMs: sql<string>`ceil(extract(epoch FROM coalesce(${events.occurredAt}, ${events.createdAt})) * 1000)::text`,
    })
    .from(events)
    .where(
      beforeId === undefined
        ? eq(events.sessionId, sessionId)
        : and(eq(events.sessionId, sessionId), lt(events.id, beforeId)),
    )
    .orderBy(desc(events.id))
    .limit(1);
  if (row) return new Date(Number(row.epochMs));
  // No stored row before it: the last one is the archived chunks' newest.
  const [archived] = await tx
    .select({
      epochMs: sql<string>`ceil(extract(epoch FROM ${sessionEventArchives.lastOccurredAt}) * 1000)::text`,
    })
    .from(sessionEventArchives)
    .where(
      beforeId === undefined
        ? eq(sessionEventArchives.sessionId, sessionId)
        : and(
            eq(sessionEventArchives.sessionId, sessionId),
            lt(sessionEventArchives.throughId, beforeId),
          ),
    )
    .orderBy(desc(sessionEventArchives.fromId))
    .limit(1);
  return archived ? new Date(Number(archived.epochMs)) : null;
}

export function notBefore(at: Date, floor: Date | null): Date {
  return floor !== null && floor.getTime() > at.getTime() ? floor : at;
}

// A server-side write to the session's event stream. The caller holds the
// session row FOR UPDATE, as every events writer must: ids are
// taken at insert, so two writers racing without it could commit out of the
// order readers see. Like every other writer, it holds the payload to the
// public event contract before storing it: the reader parses each row with
// the same schema, and a row it cannot parse is lost to every client.
export async function recordEvent(
  tx: Database,
  input: {
    sessionId: string;
    type: SessionEventName;
    payload: Record<string, unknown>;
    turnRowId: number | null;
    attemptId?: string;
    measure?: ControlStageMeasure;
    now: Date;
  },
) {
  const measure = input.measure ?? (async (_stage, work) => work());
  const checked = sessionEventPayloadSchema.parse({
    event: input.type,
    data: input.payload,
  });
  const occurredAt = notBefore(
    input.now,
    await streamClock(tx, input.sessionId),
  );
  await measure("insert_status_event_ms", () =>
    tx.insert(events).values({
      sessionId: input.sessionId,
      type: checked.event,
      payload: checked.data,
      turnId: input.turnRowId,
      // No source_sequence: that numbering is the worker's own stream.
      attemptId: input.attemptId ?? null,
      occurredAt,
    }),
  );
  await measure("notify_status_event_ms", () =>
    tx.execute(sql`SELECT pg_notify('session_events', ${input.sessionId})`),
  );
}

/**
 * The `input_wait` system record of a stage the wait reached without its
 * worker. Nothing is written for no requests.
 */
export async function recordInputWaitStage(
  tx: Database,
  input: {
    sessionId: string;
    stage: InputWaitEventData["stage"];
    requestIds: string[];
    turnRowId: number | null;
    measure?: ControlStageMeasure;
    now: Date;
  },
) {
  if (input.requestIds.length === 0) return;
  await recordEvent(tx, {
    sessionId: input.sessionId,
    type: "system",
    payload: inputWaitEventDataSchema.parse({
      type: "system",
      subtype: "input_wait",
      stage: input.stage,
      request_ids: input.requestIds,
    }),
    turnRowId: input.turnRowId,
    ...(input.measure ? { measure: input.measure } : {}),
    now: input.now,
  });
}

/**
 * A status event from the control plane. It also records whether the stream
 * now says the session is waiting for input, which is what later writes and
 * the reconciler compare against to announce the end of that wait once.
 */
export async function recordStatus(
  tx: Database,
  input: {
    sessionId: string;
    phase: StatusEventPhase;
    extra?: Record<string, unknown>;
    measure?: ControlStageMeasure;
    turnRowId: number | null;
    now: Date;
  },
) {
  await recordEvent(tx, {
    sessionId: input.sessionId,
    type: "status",
    payload: { phase: input.phase, ...input.extra },
    turnRowId: input.turnRowId,
    ...(input.measure ? { measure: input.measure } : {}),
    now: input.now,
  });
  const measure = input.measure ?? (async (_stage, work) => work());
  await measure("update_wait_announcement_ms", () =>
    tx
      .update(sessions)
      .set({ inputAnnounced: input.phase === "needs_input" })
      .where(eq(sessions.id, input.sessionId)),
  );
}

/**
 * Read before a write that can close requests: true when the stream says
 * the session is waiting and it still is at `at`. Only a wait both
 * announced and real is one whose end this write may announce; a wait that
 * already lapsed with no write is the reconciler's to report.
 */
export async function inputWaitBefore(
  tx: Database,
  session: { id: string; inputAnnounced: boolean },
  at: Date,
): Promise<boolean> {
  return session.inputAnnounced && (await awaitingInputAt(tx, session.id, at));
}

/**
 * After that write, at the same instant: if the wait ended here, say so
 * once with the status the session now reads as.
 */
export async function announceInputWaitEnded(
  tx: Database,
  input: {
    sessionId: string;
    waitingBefore: boolean;
    turnRowId: number | null;
    at: Date;
    measure?: ControlStageMeasure;
  },
) {
  if (!input.waitingBefore) return;
  const measure = input.measure ?? (async (_stage, work) => work());
  if (
    await measure("wait_after_stop_ms", () =>
      awaitingInputAt(tx, input.sessionId, input.at),
    )
  ) {
    return;
  }
  const [session] = await measure("read_stopped_session_ms", () =>
    tx
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .limit(1),
  );
  if (!session) return;
  await recordStatus(tx, {
    sessionId: input.sessionId,
    phase: publicStatus(session.status, false),
    turnRowId: input.turnRowId,
    measure,
    now: input.at,
  });
}

export type AnnouncedInputReturn = { sessionId: string; phase: string };

/**
 * Waits that ended with nothing written: a request expired, or the attempt
 * that asked lost the session, or a close or a gone execution closed the
 * requests along with the session's own status. The stream still says
 * needs_input; this says what the session reads as now. Judged again under
 * the session lock, on the database clock, so a wait an answer or a new
 * question already reported is left alone.
 */
export async function announceLapsedInputWaits(
  db: Database,
  options: { limit: number; dryRun: boolean },
): Promise<AnnouncedInputReturn[]> {
  const candidates = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.inputAnnounced, true),
        notExists(actionableOfSession(db)),
      ),
    )
    .limit(options.limit);
  const announced: AnnouncedInputReturn[] = [];
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: sessions.id,
          status: sessions.status,
          inputAnnounced: sessions.inputAnnounced,
        })
        .from(sessions)
        .where(eq(sessions.id, candidate.id))
        .limit(1)
        .for("update");
      if (!session?.inputAnnounced) return null;
      const at = await dbNow(tx);
      if (await awaitingInputAt(tx, session.id, at)) return null;
      const phase = publicStatus(session.status, false);
      if (!options.dryRun) {
        await recordStatus(tx, {
          sessionId: session.id,
          phase,
          turnRowId: null,
          now: at,
        });
      }
      return { sessionId: session.id, phase };
    });
    if (result !== null) announced.push(result);
  }
  return announced;
}
