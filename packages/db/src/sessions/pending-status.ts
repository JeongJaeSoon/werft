import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { ENDED_ATTEMPT_STATES } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { attempts, pendingRequests, sessions, turns } from "../schema.ts";

// Stored statuses of a session or turn in flight. No writer stores
// needs_input any more; a row that holds it reads like running, so the
// public status never contradicts pending_request_count.
export const IN_FLIGHT_STATUSES: ("running" | "needs_input")[] = [
  "running",
  "needs_input",
];

/**
 * The attempt that asked still owns the session and is still inside the
 * turn it asked in. Anything less and its callback is gone, whatever the
 * row says: an epoch or auth rotation, an ended attempt, a lapsed lease or
 * a closed turn each mean nobody is left to hand an answer to.
 */
export function askerIsLive(at: Date | typeof DB_NOW) {
  return and(
    eq(attempts.leaseEpoch, sessions.leaseEpoch),
    eq(attempts.executionGeneration, sessions.executionGeneration),
    eq(attempts.authRevision, sessions.authRevision),
    notInArray(attempts.state, ENDED_ATTEMPT_STATES),
    gt(attempts.leaseExpiresAt, at),
    inArray(turns.status, IN_FLIGHT_STATUSES),
    eq(turns.attemptId, pendingRequests.attemptId),
  );
}

// One instant for a whole statement: a status and a count read in the same
// SELECT must not straddle an expiry or a lease end.
const STATEMENT_NOW = sql<Date>`statement_timestamp()`;

// That instant as text, selected beside a status so a later read can judge
// at it: a JS Date would drop the microseconds and miss a boundary row.
export const READ_AT = sql<string>`statement_timestamp()::text`;

// A parked request outlives the attempt that asked: its turn ended with a
// checkpoint, and the answer is what resumes it.
export function actionable(at: Date | typeof DB_NOW) {
  return and(
    isNull(pendingRequests.resolvedAt),
    gt(pendingRequests.expiresAt, at),
    or(isNotNull(pendingRequests.parkedAt), askerIsLive(at)),
  );
}

/**
 * What a client can still act on: open, unexpired, and parked or asked by a
 * live attempt. `pending_request_count` counts the same rows, so the summary
 * and the list never disagree.
 */
export function actionablePendingWhere(sessionId: string) {
  return and(eq(pendingRequests.sessionId, sessionId), actionable(DB_NOW));
}

/**
 * The actionable requests of the outer query's `sessions` row, which
 * `askerIsLive` compares their attempt against. Read beside that row, in the
 * same statement, so its status and its count come from one snapshot.
 */
export function actionableOfSession(
  db: Database,
  kind?: "permission" | "question",
) {
  return db
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(
      and(
        eq(pendingRequests.sessionId, sessions.id),
        actionable(STATEMENT_NOW),
        kind === undefined ? undefined : eq(pendingRequests.kind, kind),
      ),
    );
}

/**
 * Whether the session has a request a person can still answer at `at`: the
 * projection above, judged at one instant a writer already holds, so a
 * before and an after read in one transaction cannot straddle an expiry.
 */
export async function awaitingInputAt(
  tx: Database,
  sessionId: string,
  at: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(and(eq(pendingRequests.sessionId, sessionId), actionable(at)))
    .limit(1);
  return row !== undefined;
}

// The same, for the outer query's `turns` row.
export function actionableOfTurn(db: Database) {
  return db
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .where(
      and(
        // Redundant with turn_id, but it is what the unresolved-by-session
        // index is keyed on.
        eq(pendingRequests.sessionId, turns.sessionId),
        eq(pendingRequests.turnId, turns.id),
        actionable(STATEMENT_NOW),
      ),
    );
}

/**
 * The one request the outer statement names, while a client can still
 * answer it.
 */
export function actionableRequest(
  db: Database,
  requestId: SQL,
  sessionId: SQL,
) {
  return db
    .select({ one: sql`1` })
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(
      and(
        sql`${pendingRequests.requestId} = ${requestId}`,
        sql`${pendingRequests.sessionId} = ${sessionId}`,
        actionable(STATEMENT_NOW),
      ),
    );
}

/**
 * What a client can answer now, for a statement that joins the request's
 * session, attempt and turn itself.
 */
export function actionableNow() {
  return actionable(STATEMENT_NOW);
}

function isInFlight(status: string): boolean {
  return (IN_FLIGHT_STATUSES as string[]).includes(status);
}

/**
 * `needs_input` is never stored: it is a running session or
 * turn with a request a person can still answer. Derived on read, it drops
 * back the instant the last one is answered, settled, expires or loses its
 * attempt, with no write or sweep to miss.
 */
export function publicStatus<S extends string>(
  stored: S,
  awaitingInput: boolean,
): S | "needs_input" | "running" {
  // An idle session that waits on a person parked its turn on their
  // requests: only a parked row is answerable with no turn in flight.
  if (stored === "idle" && awaitingInput) return "needs_input";
  if (!isInFlight(stored)) return stored;
  return awaitingInput ? "needs_input" : "running";
}

// Stored statuses publicStatus can turn into needs_input.
export const AWAITABLE_STATUSES: ("running" | "needs_input" | "idle")[] = [
  ...IN_FLIGHT_STATUSES,
  "idle",
];
