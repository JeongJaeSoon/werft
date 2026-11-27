import { ENDED_ATTEMPT_STATES } from "@werft-ai/contracts";
import { IN_FLIGHT_STATUSES, publicStatus } from "@werft-ai/platform";
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
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { attempts, pendingRequests, sessions, turns } from "../schema.ts";
import { sqlLiterals } from "../sql-literals.ts";

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
 * publicStatus as SQL, for a statement that must compare or filter on the
 * status a read shows. Its arms are publicStatus's own answers for each of
 * `values`, the stored statuses `stored` can hold there, so the rule is
 * written once.
 */
export function publicStatusSql(
  stored: SQL,
  awaitingInput: SQL,
  values: readonly string[],
): SQL<string> {
  const arms = values.flatMap((value) =>
    [true, false].flatMap((awaiting) => {
      const shown = publicStatus(value, awaiting);
      if (shown === value) return [];
      const when = awaiting ? awaitingInput : sql`NOT ${awaitingInput}`;
      return [
        sql`WHEN ${stored} = ${sqlLiterals([value])} AND ${when} THEN ${sqlLiterals([shown])}`,
      ];
    }),
  );
  return sql`(CASE ${sql.join(arms, sql` `)} ELSE ${stored} END)::text`;
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
