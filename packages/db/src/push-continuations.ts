import { and, eq, isNull, max, sql } from "drizzle-orm";
import { enqueueWithin } from "./enqueue.ts";
import type { Database } from "./queries.ts";
import { pushContinuations, sessions, turns } from "./schema.ts";

export const PUSH_CONTINUATION_MESSAGE =
  "Platform note: earlier in the previous turn you called request_push before this session had a checkpoint, so the platform deferred the push to this turn; it was not refused. That turn has ended and its checkpoint, with the commits it made, is saved now. Call request_push again with the same arguments, then finish what you were asked to do. If the push request it answers is in state requested, a person has to approve the push before it runs: do not wait for it or call open_pull_request again in this turn; end your turn and ask a person to approve the push. Once a push request is approved, the push runs in the background: if open_pull_request answers not_pushed with push_request_state approved or pushing, wait a few seconds and call it again.";

export async function runningTurnOf(
  db: Database,
  input: { sessionId: string; attemptId: string },
): Promise<number | null> {
  const [turn] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, input.sessionId),
        eq(turns.attemptId, input.attemptId),
        eq(turns.status, "running"),
      ),
    )
    .limit(1);
  return turn?.id ?? null;
}

/**
 * Marks the turn a refused push request started in, while it still runs.
 * False when it has ended (a late refusal must not mark the next turn), or
 * it is itself a continuation: its session already has a checkpoint, so a
 * second one would only repeat the refusal.
 */
export function markPushContinuation(
  db: Database,
  input: { sessionId: string; turnId: number },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Finalize holds this lock while it ends the turn and reads the mark, so
    // a mark either lands before it or finds the turn no longer running.
    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for("update");
    const [turn] = await tx
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(
          eq(turns.id, input.turnId),
          eq(turns.sessionId, input.sessionId),
          eq(turns.status, "running"),
        ),
      )
      .limit(1);
    if (turn === undefined) return false;
    const [continued] = await tx
      .select({ turnId: pushContinuations.turnId })
      .from(pushContinuations)
      .where(eq(pushContinuations.continuationTurnId, turn.id))
      .limit(1);
    if (continued !== undefined) return false;
    await tx
      .insert(pushContinuations)
      .values({ turnId: turn.id })
      .onConflictDoNothing();
    return true;
  });
}

/**
 * Called in the finalize transaction of a turn that completed with a
 * checkpoint, under the session lock: queues the continuation the turn was
 * marked for, at most once.
 */
export async function queuePushContinuation(
  tx: Database,
  input: {
    session: typeof sessions.$inferSelect;
    turnRowId: number;
  },
): Promise<boolean> {
  const { session } = input;
  // A paused, closing or recovering session takes no turn the platform
  // makes up; the mark stays unused.
  if (
    session.admissionState !== "active" ||
    session.takeoverRequiredAt !== null
  ) {
    return false;
  }
  const [mark] = await tx
    .select({ turnId: pushContinuations.turnId })
    .from(pushContinuations)
    .where(
      and(
        eq(pushContinuations.turnId, input.turnRowId),
        isNull(pushContinuations.continuationTurnId),
      ),
    )
    .limit(1)
    .for("update");
  if (mark === undefined) return false;
  const [marked] = await tx
    .select({ sequence: turns.sequence, actorId: turns.actorId })
    .from(turns)
    .where(eq(turns.id, input.turnRowId));
  const [last] = await tx
    .select({ sequence: max(turns.sequence) })
    .from(turns)
    .where(eq(turns.sessionId, session.id));
  // A person's later input runs first and may leave another checkpoint, so
  // "the same arguments" could pin a commit that was never asked for.
  if (marked === undefined || (last?.sequence ?? 0) > marked.sequence) {
    return false;
  }
  const [turn] = await tx
    .insert(turns)
    .values({
      sessionId: session.id,
      sequence: (last?.sequence ?? 0) + 1,
      message: PUSH_CONTINUATION_MESSAGE,
      status: "queued",
      createdAt: sql`clock_timestamp()`,
      actorId: marked.actorId,
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert the push continuation turn");
  await tx
    .update(pushContinuations)
    .set({ continuationTurnId: turn.id })
    .where(eq(pushContinuations.turnId, input.turnRowId));
  await enqueueWithin(tx, {
    sessionId: session.id,
    turnId: turn.id,
    payload: { message: PUSH_CONTINUATION_MESSAGE },
  });
  return true;
}
