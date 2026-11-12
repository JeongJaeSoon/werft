import type { ReceiptActor } from "@werft-ai/contracts";
import type { Principal, SessionBudget } from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  min,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  attempts,
  idempotencyKeys,
  memberships,
  receipts,
  sessions,
  turns,
  users,
  workerLaunches,
} from "./schema.ts";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

const LIKE_SPECIAL = /[\\%_]/g;

/** A (I)LIKE pattern matching `text` anywhere, its wildcards taken literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(LIKE_SPECIAL, "\\$&")}%`;
}

const TURN_ID = /^[1-9]\d{0,9}$/;
// turns.sequence is a PostgreSQL integer; a larger id cannot exist and must
// not reach the query, where it would fail with 22003 instead of not-found.
export const SEQUENCE_MAX = 2_147_483_647;

/**
 * A public turn id as a sequence, by the same canonical rule as the turn
 * reader: "1e0" or " 1" must not settle turn 1, and "abc" or an out-of-range
 * number must not reach the query as a 500.
 */
export function parseTurnSequence(turnId: string): number | null {
  if (!TURN_ID.test(turnId)) return null;
  const sequence = Number(turnId);
  return sequence <= SEQUENCE_MAX ? sequence : null;
}

export const OPEN_TURN_STATUSES = ["running", "needs_input"];
export const ENDED_ATTEMPT_STATES = ["exited", "lost"];

// What a worker may be launched for and claim: an active session, and a
// resuming one, whose new worker restores the pause's checkpoint first.
export const LAUNCHABLE_ADMISSION_STATES: Array<
  (typeof sessions.admissionState.enumValues)[number]
> = ["active", "resuming"];

// budgetExceeded's negation as a condition on `sessions`, for queries that
// pick sessions that may still run.
export function withinBudget(budget: SessionBudget): SQL {
  const cost = lt(sessions.costUsd, budget.costUsd);
  if (budget.tokens === null) return cost;
  return and(cost, lt(sessions.providerTokens, budget.tokens)) as SQL;
}

// Receipts written for the inputs a decision or a cancellation settles.
export const INPUT_RECEIPT_OPERATIONS = ["create_session", "append_message"];

export type IdempotencyScope = {
  principal: string;
  operation: string;
  resource: string;
  key: string;
  actor: ReceiptActor | null;
  requestId: string | null;
};

/**
 * The actor's user row, before any membership: accepting takes it in that
 * order, and an invite's invited_by key check would otherwise wait on it
 * while holding the membership. A share lock rather than a key share, so an
 * account disable either waits for this write or is seen by it — re-checked
 * after a membership lock wait, a joined user row is the old snapshot's.
 */
export async function lockActorAccount(tx: Database, userId: string) {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("share");
}

/**
 * Several people's user rows, then their memberships of `workspaceId`, each
 * in user_id order as a suspension and a role change take them, so a write
 * that reads the actor and the person it acts on queues behind those
 * instead of deadlocking them.
 */
export async function lockPeople(
  tx: Database,
  workspaceId: string,
  userIds: readonly string[],
) {
  const ids = [...new Set(userIds)];
  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids))
    .orderBy(asc(users.id))
    .for("share");
  return tx
    .select({
      userId: memberships.userId,
      role: memberships.role,
      live: sql<boolean>`${memberships.disabledAt} is null and ${users.disabledAt} is null`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        inArray(memberships.userId, ids),
      ),
    )
    .orderBy(asc(memberships.userId))
    .for("share", { of: memberships });
}

// Authorization read the membership before this transaction opened. The share
// locks make an offboarding or a suspension that commits since then either
// wait for this write (and see what it wrote) or be seen here. Take them
// before any session row lock: user, membership, session.
export async function actorStillMember(
  tx: Database,
  principal: Principal,
): Promise<boolean> {
  const actor = principal.actor;
  if (!actor?.userId || !actor.workspaceId) return true;
  await lockActorAccount(tx, actor.userId);
  const live = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, actor.workspaceId),
        eq(memberships.userId, actor.userId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1)
    .for("share", { of: memberships });
  return live.length > 0;
}

export type ControlStageMeasure = <T>(
  stage: string,
  work: () => Promise<T>,
) => Promise<T>;

// An advisory lock serializes same-key races; SELECT FOR UPDATE cannot lock a
// row that does not exist yet. Always taken before any row lock so every
// transaction acquires locks in the same order.
export async function lockIdempotencyScope(
  tx: Database,
  scope: IdempotencyScope,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify([scope.principal, scope.operation, scope.resource, scope.key])}))`,
  );
}

export async function findIdempotent(tx: Database, scope: IdempotencyScope) {
  const [existing] = await tx
    .select({
      payloadHash: idempotencyKeys.payloadHash,
      receiptId: receipts.id,
      result: receipts.result,
      status: receipts.status,
    })
    .from(idempotencyKeys)
    .innerJoin(receipts, eq(receipts.id, idempotencyKeys.receiptId))
    .where(
      and(
        eq(idempotencyKeys.principal, scope.principal),
        eq(idempotencyKeys.operation, scope.operation),
        eq(idempotencyKeys.resource, scope.resource),
        eq(idempotencyKeys.key, scope.key),
      ),
    )
    .limit(1);
  return existing;
}

// A replay reports the receipt's current status, since the row is the only
// record of it.
export function controlReplay(
  existing: Awaited<ReturnType<typeof findIdempotent>>,
  payloadHash: string,
) {
  if (!existing) return undefined;
  if (existing.payloadHash !== payloadHash) {
    return { outcome: "conflict" as const };
  }
  return {
    outcome: "replayed" as const,
    response: {
      receipt_id: existing.receiptId,
      receipt_status: existing.status,
    },
  };
}

/**
 * The turn a control receipt reports as unconfirmed: the earliest one whose
 * outcome is unknown, from this exit or from one the session was already
 * recovering from. Null when every turn has a known outcome.
 */
export async function earliestUnknownTurn(
  tx: Database,
  sessionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ sequence: min(turns.sequence) })
    .from(turns)
    .where(
      and(eq(turns.sessionId, sessionId), eq(turns.status, "outcome_unknown")),
    );
  return row?.sequence === null || row?.sequence === undefined
    ? null
    : String(row.sequence);
}

export class BindingMoved extends Error {
  constructor(sessionId: string, attempt: number) {
    super(
      `Session ${sessionId} changed its execution while control attempt ${attempt} waited for the launch lock`,
    );
  }
}

// drizzle wraps the driver's error, so the code may sit on its cause.
export function findPgError(
  error: unknown,
  code: string,
): { constraint?: unknown } | undefined {
  for (let e = error; typeof e === "object" && e !== null; ) {
    const found = e as { code?: unknown; constraint?: unknown };
    if (found.code === code) return found;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function isDeadlock(error: unknown): boolean {
  return findPgError(error, "40P01") !== undefined;
}

/**
 * Runs `work` in a transaction, restarting it when the session's binding
 * moved under it (see lockSessionForControl) or PostgreSQL chose it as a
 * deadlock victim. A worker claim locks the dispatch signal before the
 * session, and the control paths that clear the signal hold the session
 * first; the victim's transaction is rolled back whole, so running it again
 * is safe. Three attempts is plenty: a binding moves once per launch, and
 * launches are seconds apart.
 */
export async function transactionWithBindingRetry<T>(
  db: Database,
  work: (tx: Database, attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction((tx) => work(tx, attempt));
    } catch (error) {
      const retryable = error instanceof BindingMoved || isDeadlock(error);
      if (!retryable || attempt >= 3) throw error;
    }
  }
}

/**
 * The claimed attempt still holding the binding, if any: only it can drain
 * for a pause or close. A launch reserved and not yet claimed never will be
 * now — claims take active sessions only — and an attempt that ended is on
 * its way out anyway.
 */
export async function liveDrainer(
  tx: Database,
  executionId: string | null,
): Promise<{ id: string } | undefined> {
  if (executionId === null) return undefined;
  const [drainer] = await tx
    .select({ id: attempts.id })
    .from(workerLaunches)
    .innerJoin(attempts, eq(attempts.id, workerLaunches.claimedAttemptId))
    .where(
      and(
        eq(workerLaunches.executionId, executionId),
        notInArray(attempts.state, ["exited", "lost"]),
      ),
    )
    .limit(1);
  return drainer;
}

/**
 * Lock order is launch, then session, as confirmExecutionGone takes them.
 * The launch is known only from the session row, so it is read unlocked
 * first; if the binding moved while the launch lock was taken, the caller
 * starts the transaction over rather than locking the new launch out of
 * order. The session row lock serializes this against every other control
 * and against the gateway paths, which lock the session before the attempt;
 * no attempt row is locked here, so the order holds.
 */
export async function lockSessionForControl(
  tx: Database,
  // No owner for an operator command, which acts on any session.
  input: {
    sessionId: string;
    ownerId?: string;
    attempt: number;
    measure?: ControlStageMeasure;
  },
) {
  const measure = input.measure ?? (async (_stage, work) => work());
  const owned = and(
    eq(sessions.id, input.sessionId),
    input.ownerId === undefined
      ? undefined
      : eq(sessions.ownerId, input.ownerId),
  );
  const [peek] = await measure("session_binding_peek_ms", () =>
    tx
      .select({ executionId: sessions.executionId })
      .from(sessions)
      .where(owned)
      .limit(1),
  );
  if (peek?.executionId) {
    const executionId = peek.executionId;
    await measure("launch_lock_ms", () =>
      tx
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, executionId))
        .limit(1)
        .for("update"),
    );
  }
  const [session] = await measure("session_lock_ms", () =>
    tx.select().from(sessions).where(owned).limit(1).for("update"),
  );
  if (!session) return null;
  if (session.executionId !== (peek?.executionId ?? null)) {
    throw new BindingMoved(input.sessionId, input.attempt);
  }
  return session;
}

/**
 * Waiting for the session lock is real time; an append that held it
 * committed rows stamped after the caller read its clock, and this
 * transaction's stamps must not fall before them. Same rule as the gateway
 * paths: caller clock plus the wait, so injected clocks hold.
 */
export function controlClock(callerNow: Date, startedAt: number): Date {
  return new Date(callerNow.getTime() + Math.max(0, Date.now() - startedAt));
}

/**
 * Reports accepted receipts matching `overdue` as unknown, at most `limit`
 * of them: a backlog is worked off over several passes rather than
 * in one statement that can outlast the pass. The batch is read and locked
 * first, in its own statement, because a `LIMIT … FOR UPDATE` subquery inside
 * the UPDATE may be rescanned and flip more than `limit`. The oldest go first
 * so a receipt cannot wait behind a backlog that keeps growing. A
 * row another transaction holds is left to the next pass, not waited on.
 */
export async function expireOverdueReceipts(
  db: Database,
  input: {
    overdue: SQL | undefined;
    message: string;
    now: Date;
    dryRun?: boolean;
    limit?: number;
    onExpired?: (
      receipts: readonly {
        createdAt: Date;
        id: string;
        operation: string;
        targetRef: unknown;
      }[],
    ) => void | Promise<void>;
  },
): Promise<number> {
  const candidates = (from: Database) => {
    const query = from
      .select({
        createdAt: receipts.createdAt,
        id: receipts.id,
        operation: receipts.operation,
        targetRef: receipts.targetRef,
      })
      .from(receipts)
      .where(and(eq(receipts.status, "accepted"), input.overdue))
      .$dynamic();
    return input.limit === undefined
      ? query
      : query.orderBy(receipts.createdAt, receipts.id).limit(input.limit);
  };
  if (input.dryRun) return (await candidates(db)).length;
  const expired = await db.transaction(async (tx) => {
    const batch = await candidates(tx).for("update", { skipLocked: true });
    if (batch.length === 0) return batch;
    await tx
      .update(receipts)
      .set({
        status: "unknown",
        error: { code: "BACKEND_UNAVAILABLE", message: input.message },
        updatedAt: input.now,
      })
      .where(
        inArray(
          receipts.id,
          batch.map(({ id }) => id),
        ),
      );
    return batch;
  });
  await input.onExpired?.(expired);
  return expired.length;
}
