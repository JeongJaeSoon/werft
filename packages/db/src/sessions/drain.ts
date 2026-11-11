import type {
  AdmissionState,
  CloseBlockedReason,
  SessionAttention,
} from "@werft-ai/contracts";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { fromDbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { receipts, type sessions } from "../schema.ts";
import {
  PAUSE,
  PAUSE_DRAIN_DEADLINE_MS,
  pauseBlocker,
} from "./pause-control.ts";

export const CLOSE = "close";

/**
 * The admission states a bound worker drains in, and where a drain that
 * reaches its safe boundary settles. A pause and a close drain the same way
 * (the worker sees a `pause` control either way); only the settlement and
 * the receipt's operation differ.
 */
const DRAINING = {
  pausing: { operation: PAUSE, settlesInto: "paused" },
  closing: { operation: CLOSE, settlesInto: "closed" },
} as const satisfies Partial<
  Record<AdmissionState, { operation: string; settlesInto: AdmissionState }>
>;

export type DrainingState = keyof typeof DRAINING;
export type Drain = (typeof DRAINING)[DrainingState];

export const DRAINING_STATES = Object.keys(DRAINING) as DrainingState[];

export function drainOf(state: AdmissionState): Drain | undefined {
  return Object.hasOwn(DRAINING, state)
    ? DRAINING[state as DrainingState]
    : undefined;
}

/**
 * The pause or close receipt still waiting on its execution. Only looked up
 * while the session is draining, the one time it can hold one, since the
 * target_ref match reads receipts without an index.
 */
export function openDrainReceipt(sessionId: string) {
  return and(
    inArray(receipts.operation, [PAUSE, CLOSE]),
    eq(receipts.status, "accepted"),
    sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
  );
}

type SessionRow = typeof sessions.$inferSelect;
type BlockerSession = Pick<
  SessionRow,
  | "id"
  | "admissionState"
  | "checkpointRevision"
  | "checkpointFallbackRevision"
  | "checkpointPendingReason"
  | "contextResetCheckpointRevision"
  | "pauseReason"
>;

/** pauseBlocker, judged for the drain the session is in. */
export function drainBlocker(tx: Database, session: BlockerSession) {
  return pauseBlocker(tx, session, {
    closing: session.admissionState === "closing",
  });
}

/**
 * PAUSE_BLOCKED or CLOSE_BLOCKED once the drain deadline has passed with the
 * drain still short of its safe boundary. Worked out on read from the same
 * facts the drain is settled on, so it cannot disagree with them or outlive
 * them. A close also says when nothing blocks it any more and only the
 * execution's absence is still to be seen.
 */
export async function drainAttention(
  db: Database,
  session: BlockerSession,
): Promise<SessionAttention | null> {
  if (drainOf(session.admissionState) === undefined) return null;
  const [overdue] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        openDrainReceipt(session.id),
        lte(receipts.createdAt, fromDbNow(-PAUSE_DRAIN_DEADLINE_MS)),
      ),
    )
    .limit(1);
  if (!overdue) return null;
  const reason = await drainBlocker(db, session);
  if (session.admissionState === "closing") {
    return {
      code: "CLOSE_BLOCKED",
      reason: reason ?? ("execution_pending" satisfies CloseBlockedReason),
    };
  }
  return reason === null ? null : { code: "PAUSE_BLOCKED", reason };
}
