import { publicStatus } from "@werft-ai/platform";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { closeSessionRow } from "../recovery-control.ts";
import { sessions } from "../schema.ts";
import { hasRestorePoint, restoreBaseRevision } from "./pause-policy.ts";
import { awaitingInputAt } from "./pending-status.ts";
import { recordEvent, recordStatus } from "./session-events.ts";

/** Who closed it, on the session_closed event and the status event. */
export const AGENTLESS_CLOSE = "agentless_cleanup";
/** Why: the session names no agent release, so no claim can ever run it. */
export const NO_AGENT_RELEASE = "no_agent_release";

export type AgentlessSessionsClosed = {
  closed: string[];
  failed: { sessionId: string; error: unknown }[];
};

const withoutRelease = and(
  isNull(sessions.agentReleaseId),
  ne(sessions.admissionState, "closed"),
);

/**
 * Closes every session that names no agent release, each in a transaction
 * of its own, the way a recovery close leaves a session. Such a session was
 * accepted before a release was required; with nothing to claim it with,
 * it stays open forever otherwise. Run at each host start: a closed one is
 * not found again, and no path makes a new one. A session that fails is
 * reported and the rest go on.
 */
export async function closeAgentlessSessions(
  db: Database,
): Promise<AgentlessSessionsClosed> {
  const found = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(withoutRelease)
    .orderBy(asc(sessions.id));
  const result: AgentlessSessionsClosed = { closed: [], failed: [] };
  for (const { id } of found) {
    try {
      if (await db.transaction((tx) => closeOne(tx, id))) {
        result.closed.push(id);
      }
    } catch (error) {
      result.failed.push({ sessionId: id, error });
    }
  }
  return result;
}

async function closeOne(tx: Database, sessionId: string): Promise<boolean> {
  const [session] = await tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), withoutRelease))
    .for("update");
  if (session === undefined) return false;
  const now = await dbNow(tx);
  const { cancelledTurnCount } = await closeSessionRow(
    tx,
    session,
    now,
    "superseded by closing a session without an agent release",
  );
  await recordStatus(tx, {
    sessionId,
    phase: publicStatus("stopped", await awaitingInputAt(tx, sessionId, now)),
    extra: { admission_state: "closed", closed_by: AGENTLESS_CLOSE },
    turnRowId: null,
    now,
  });
  await recordEvent(tx, {
    sessionId,
    type: "system",
    payload: {
      type: "system",
      subtype: "session_closed",
      closed_by: AGENTLESS_CLOSE,
      reason: NO_AGENT_RELEASE,
      checkpoint_revision: hasRestorePoint(session)
        ? restoreBaseRevision(session)
        : null,
      cancelled_turn_count: cancelledTurnCount,
    },
    turnRowId: null,
    now,
  });
  return true;
}
