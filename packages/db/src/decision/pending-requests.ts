import { randomUUID } from "node:crypto";
import {
  type ApprovalRecord,
  approvalRecordSchema,
  type InputWait,
  PENDING_REQUEST_KIND_VALUES,
  type PendingQuestion,
  type PendingRememberRule,
  type PendingRequest,
  pendingQuestionSchema,
  presentPendingRequest,
  questionAnswerMismatch,
  sessionMessageSchema,
} from "@werft-ai/contracts";
import type {
  AnswerRequestInput,
  AnswerRequestResult,
  PendingRequestDisplayReader,
  PendingRequestStore,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  type ControlStageMeasure,
  ENDED_ATTEMPT_STATES,
  earliestUnknownTurn,
  findIdempotent,
  hasRestorePoint,
  lockIdempotencyScope,
  receiptActorOf,
} from "../control-shared.ts";
import { DB_NOW, dbNow } from "../db-clock.ts";
import { toolSummaryContext } from "../push-requests.ts";
import type { Database } from "../queries.ts";
import {
  attempts,
  idempotencyKeys,
  pendingRequests,
  receipts,
  sessions,
  turns,
} from "../schema.ts";
import { contextCoverage, contextGap } from "../sessions/context-gap.ts";
import {
  closeParkedGroup,
  continuationMessage,
} from "../sessions/parked-group.ts";
import {
  keyReaches,
  lockRequester,
  lockSessionReach,
} from "../sessions/requester-locks.ts";
import {
  announceInputWaitEnded,
  inputWaitBefore,
  recordInputWaitStage,
} from "../sessions/session-events.ts";

const ANSWER = "answer";
// Stored statuses of a session or turn in flight. No writer stores
// needs_input any more; a row that holds it reads like running, so the
// public status never contradicts pending_request_count.
export const IN_FLIGHT_STATUSES: ("running" | "needs_input")[] = [
  "running",
  "needs_input",
];

type SessionRow = typeof sessions.$inferSelect;

type StoredPayload =
  | {
      kind: "permission";
      tool: string;
      input: NonNullable<unknown> | null;
      /** The rules the run offered to keep for the session; never listed by the API. */
      remember_offer?: PendingRememberRule[];
    }
  | { kind: "question"; questions: PendingQuestion[] };

/**
 * The attempt that asked still owns the session and is still inside the
 * turn it asked in. Anything less and its callback is gone, whatever the
 * row says: an epoch or auth rotation, an ended attempt, a lapsed lease or
 * a closed turn each mean nobody is left to hand an answer to.
 */
function askerIsLive(at: Date | typeof DB_NOW) {
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
function actionable(at: Date | typeof DB_NOW) {
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

export function isInFlight(status: string): boolean {
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

/**
 * Closes the session's open requests that a worker holds, as its execution
 * goes: nobody can answer them any more. A parked one waits for no worker
 * and stays open. Says which were still waiting rather than already past
 * their expiry, and the turn of each.
 */
export async function closeWorkerRequests(
  tx: Database,
  sessionId: string,
  now: Date,
): Promise<ClosedRequest[]> {
  return tx
    .update(pendingRequests)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        isNull(pendingRequests.resolvedAt),
        isNull(pendingRequests.parkedAt),
      ),
    )
    .returning({
      requestId: pendingRequests.requestId,
      turnRowId: pendingRequests.turnId,
      waiting: sql<boolean>`${pendingRequests.expiresAt} > statement_timestamp()`,
    });
}

export type ClosedRequest = {
  requestId: string;
  turnRowId: number;
  waiting: boolean;
};

/**
 * Parks what the finalized turn still waits on: every unexpired row its
 * worker has not settled, an answer that came after the worker cut the
 * turn included, since that answer is what resumes it. The group expires
 * together, at its earliest expiry. Returns the parked ids.
 */
export async function parkTurnRequests(
  tx: Database,
  input: { sessionId: string; turnRowId: number; now: Date },
): Promise<string[]> {
  const unsettled = and(
    eq(pendingRequests.sessionId, input.sessionId),
    eq(pendingRequests.turnId, input.turnRowId),
    isNull(pendingRequests.settledAt),
    isNull(pendingRequests.parkedAt),
    gt(pendingRequests.expiresAt, input.now),
  );
  const [group] = await tx
    .select({
      expiresAt: sql<Date | null>`min(${pendingRequests.expiresAt})`.mapWith(
        pendingRequests.expiresAt,
      ),
    })
    .from(pendingRequests)
    .where(unsettled);
  if (group?.expiresAt == null) return [];
  const parked = await tx
    .update(pendingRequests)
    .set({ parkedAt: input.now, expiresAt: group.expiresAt })
    .where(unsettled)
    .returning({ requestId: pendingRequests.requestId });
  return parked.map((row) => row.requestId).sort();
}

/**
 * The `lost` stage for the waits closeWorkerRequests ended: the question or
 * approval went with its worker unanswered (design D-12).
 */
export async function recordLostInputWait(
  tx: Database,
  input: {
    sessionId: string;
    closed: ClosedRequest[];
    measure?: ControlStageMeasure;
    now: Date;
  },
) {
  const lost = input.closed.filter((request) => request.waiting);
  const turnRowIds = new Set(lost.map((request) => request.turnRowId));
  await recordInputWaitStage(tx, {
    sessionId: input.sessionId,
    stage: "lost",
    requestIds: lost.map((request) => request.requestId),
    turnRowId: turnRowIds.size === 1 ? ([...turnRowIds][0] ?? null) : null,
    ...(input.measure ? { measure: input.measure } : {}),
    now: input.now,
  });
}

/**
 * The execution is gone, so answers it was handed but never acknowledged
 * may or may not have reached their callbacks. Their receipts say unknown,
 * not failed: an approval could have been acted on before the worker died.
 * The rows are closed for good either way. A parked row is not the gone
 * execution's: its answer waits for the turn that resumes it.
 */
export async function abandonUndeliveredAnswers(
  tx: Database,
  sessionId: string,
  now: Date,
) {
  const abandoned = await tx
    .update(pendingRequests)
    .set({ settledAt: now, settledOutcome: "lost" })
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        isNotNull(pendingRequests.answeredAt),
        isNull(pendingRequests.settledAt),
        isNull(pendingRequests.parkedAt),
      ),
    )
    .returning({ receiptId: pendingRequests.answerReceiptId });
  const receiptIds = abandoned.flatMap((row) =>
    row.receiptId === null ? [] : [row.receiptId],
  );
  if (receiptIds.length === 0) return;
  await tx
    .update(receipts)
    .set({
      status: "unknown",
      error: {
        code: "REQUEST_STALE",
        message:
          "the execution ended before confirming the answer reached its request",
      },
      updatedAt: now,
    })
    .where(
      and(inArray(receipts.id, receiptIds), eq(receipts.status, "accepted")),
    );
}

/**
 * A person ended what a parked turn was waiting to resume: its requests,
 * answered or not, settle as cancelled, since no worker is left to say so.
 * An answer given to one did nothing, and its receipt says that.
 */
export async function cancelParkedRequests(
  tx: Database,
  scope: { sessionId: string; turnRowId?: number },
  now: Date,
) {
  const cancelled = await tx
    .update(pendingRequests)
    .set({
      resolvedAt: sql`coalesce(${pendingRequests.resolvedAt}, ${now})`,
      settledAt: now,
      settledOutcome: "cancelled",
    })
    .where(
      and(
        eq(pendingRequests.sessionId, scope.sessionId),
        scope.turnRowId === undefined
          ? undefined
          : eq(pendingRequests.turnId, scope.turnRowId),
        isNotNull(pendingRequests.parkedAt),
        // An expired row is still its group's until the group closes;
        // left as it is, the cancelled group would wait for a resume.
        or(
          isNull(pendingRequests.settledAt),
          eq(pendingRequests.settledOutcome, "expired"),
        ),
      ),
    )
    .returning({ receiptId: pendingRequests.answerReceiptId });
  const receiptIds = cancelled.flatMap((row) =>
    row.receiptId === null ? [] : [row.receiptId],
  );
  if (receiptIds.length === 0) return;
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "REQUEST_STALE",
        message:
          "the parked request was cancelled before its answer resumed the turn",
      },
      updatedAt: now,
    })
    .where(
      and(inArray(receipts.id, receiptIds), eq(receipts.status, "accepted")),
    );
}

type InputWaitRow = {
  sessionId: string;
  requestId: string;
  kind: string;
  createdAt: Date;
  parkAt: Date | null;
  parkedAt: Date | null;
  expiresAt: Date;
};

function inputWaitOf(
  state: InputWait["state"],
  rows: InputWaitRow[],
): InputWait {
  const earliest = (dates: Date[]) =>
    dates.reduce((a, b) => (b < a ? b : a)).toISOString();
  const parkAts = rows.flatMap((row) => row.parkAt ?? []);
  return {
    state,
    since: earliest(rows.map((row) => row.createdAt)),
    kinds: PENDING_REQUEST_KIND_VALUES.filter((kind) =>
      rows.some((row) => row.kind === kind),
    ),
    request_ids: rows.map((row) => row.requestId),
    park_at: parkAts.length === 0 ? null : earliest(parkAts),
    expires_at: earliest(rows.map((row) => row.expiresAt)),
  };
}

/**
 * Each session's `input_wait`, read from the rows the pending list shows: a
 * parked row makes it `parked`, a park the platform is draining `parking`,
 * anything else open `waiting`. With nothing open, a session still paused
 * for its park reads `expired` when every request of the turn it parked
 * expired, the group it would resume on. Judged at `readAt` (`READ_AT` of
 * the statement that projected the rows' status), so a session never reads
 * needs_input beside a wait of null.
 */
export async function readInputWaits(
  executor: Database,
  rows: Pick<SessionRow, "id" | "admissionState" | "pauseReason">[],
  readAt: string,
): Promise<Map<string, InputWait | null>> {
  const result = new Map<string, InputWait | null>();
  if (rows.length === 0) return result;
  const select = {
    sessionId: pendingRequests.sessionId,
    requestId: pendingRequests.requestId,
    kind: sql<string>`${pendingRequests.payload}->>'kind'`,
    createdAt: pendingRequests.createdAt,
    parkAt: pendingRequests.parkAt,
    parkedAt: pendingRequests.parkedAt,
    expiresAt: pendingRequests.expiresAt,
  };
  const open = await executor
    .select(select)
    .from(pendingRequests)
    .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
    .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
    .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
    .where(
      and(
        inArray(
          pendingRequests.sessionId,
          rows.map((row) => row.id),
        ),
        actionable(sql<Date>`${readAt}::timestamptz`),
      ),
    )
    .orderBy(asc(pendingRequests.createdAt), asc(pendingRequests.requestId));
  const parkHeld = rows.filter(
    (row) =>
      row.pauseReason === "awaiting_input" &&
      row.admissionState === "paused" &&
      !open.some((request) => request.sessionId === row.id),
  );
  const lastParked =
    parkHeld.length === 0
      ? []
      : await executor
          .select({ ...select, settledOutcome: pendingRequests.settledOutcome })
          .from(pendingRequests)
          .where(
            and(
              inArray(
                pendingRequests.sessionId,
                parkHeld.map((row) => row.id),
              ),
              sql`${pendingRequests.turnId} = (
          SELECT max(p.turn_id) FROM ${pendingRequests} p
          WHERE p.session_id = ${pendingRequests.sessionId}
            AND p.parked_at IS NOT NULL
        )`,
              isNotNull(pendingRequests.parkedAt),
            ),
          )
          .orderBy(
            asc(pendingRequests.createdAt),
            asc(pendingRequests.requestId),
          );
  for (const row of rows) {
    const mine = open.filter((request) => request.sessionId === row.id);
    if (mine.length > 0) {
      result.set(
        row.id,
        inputWaitOf(
          mine.some((request) => request.parkedAt !== null)
            ? "parked"
            : row.pauseReason === "awaiting_input" &&
                row.admissionState === "pausing"
              ? "parking"
              : "waiting",
          mine,
        ),
      );
      continue;
    }
    const group = lastParked.filter((request) => request.sessionId === row.id);
    result.set(
      row.id,
      group.length > 0 &&
        group.every((request) => request.settledOutcome === "expired")
        ? inputWaitOf("expired", group)
        : null,
    );
  }
  return result;
}

export function publicPendingRequest(row: {
  requestId: string;
  turnSequence: number;
  attemptId: string;
  payload: unknown;
  createdAt: Date;
  expiresAt: Date;
  parkAt: Date | null;
  parkedAt: Date | null;
}): PendingRequest {
  const payload = row.payload as StoredPayload;
  const base = {
    request_id: row.requestId,
    turn_id: String(row.turnSequence),
    attempt_id: row.attemptId,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    state: row.parkedAt === null ? ("waiting" as const) : ("parked" as const),
    park_at: row.parkAt?.toISOString() ?? null,
    group: String(row.turnSequence),
  };
  return payload.kind === "permission"
    ? { ...base, kind: "permission", tool: payload.tool, input: payload.input }
    : { ...base, kind: "question", questions: payload.questions };
}

function answerMismatch(
  payload: StoredPayload,
  answer: AnswerRequestInput["answer"],
): string | null {
  if (payload.kind !== answer.kind) {
    return `A ${answer.kind} answer cannot settle a ${payload.kind} request`;
  }
  if (answer.kind === "permission") {
    // Nothing offered, nothing to keep: the worker would drop it, and the
    // person would believe a rule exists that does not.
    return answer.remember !== undefined &&
      (payload as { remember_offer?: unknown[] }).remember_offer === undefined
      ? "This request offered nothing to allow for the session"
      : null;
  }
  const questions = pendingQuestionSchema
    .array()
    .parse((payload as { questions: unknown }).questions);
  return questionAnswerMismatch(questions, answer.answers);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A request closed while its session stood here was closed with it.
const SESSION_ENDED_STATES: ReadonlySet<string> = new Set([
  "stopping",
  "stopped",
  "closing",
  "closed",
]);

export function createPostgresPendingRequests(
  db: Database,
): PendingRequestStore & PendingRequestDisplayReader {
  return {
    async requestOutcome(ownerId, sessionId, requestId) {
      const [row] = await db
        .select({
          kind: pendingRequests.kind,
          answer: pendingRequests.answer,
          open: sql<boolean>`EXISTS (${actionableRequest(
            db,
            sql`${requestId}`,
            sql`${sessionId}::uuid`,
          )})`,
        })
        .from(pendingRequests)
        .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
        .where(
          and(
            eq(pendingRequests.requestId, requestId),
            eq(pendingRequests.sessionId, sessionId),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const kind = row.kind === "permission" ? "permission" : "question";
      if (row.open) return { state: "open", kind };
      if (row.answer === null) return { state: "closed", kind };
      if (kind === "question") return { state: "answered", kind };
      const stored = row.answer as { decision?: unknown; remember?: unknown };
      return {
        state: "answered",
        kind,
        decision: stored.decision === "allow" ? "allow" : "deny",
        ...(stored.decision === "allow" && stored.remember === "session"
          ? { remember: "session" as const }
          : {}),
      };
    },

    async displayOf(ownerId, sessionId, requestId) {
      if (!UUID.test(sessionId)) return null;
      const [row] = await db
        .select({
          payload: pendingRequests.payload,
          answer: pendingRequests.answer,
          answeredBy: pendingRequests.answeredBy,
          createdAt: pendingRequests.createdAt,
          expiresAt: pendingRequests.expiresAt,
          expired: sql<boolean>`${pendingRequests.expiresAt} <= ${DB_NOW}`,
          admissionState: sessions.admissionState,
          open: sql<boolean>`EXISTS (${actionableRequest(
            db,
            sql`${requestId}`,
            sql`${sessionId}::uuid`,
          )})`,
        })
        .from(pendingRequests)
        .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
        .where(
          and(
            eq(pendingRequests.requestId, requestId),
            eq(pendingRequests.sessionId, sessionId),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      const payload = row.payload as {
        kind?: string;
        tool?: unknown;
        input?: unknown;
        questions?: unknown;
      };
      const answer = row.answer as {
        decision?: unknown;
        remember?: unknown;
        answers?: {
          question_id?: unknown;
          selected_option_ids?: unknown;
          free_text?: unknown;
        }[];
      } | null;
      const state = row.open
        ? ("open" as const)
        : answer === null
          ? ("closed" as const)
          : ("answered" as const);
      const decider = (row.answeredBy as { actor_user_id?: unknown } | null)
        ?.actor_user_id;
      const base = {
        state,
        decision:
          state === "answered" && payload.kind === "permission"
            ? answer?.decision === "allow"
              ? ("allow" as const)
              : ("deny" as const)
            : null,
        remember:
          state === "answered" &&
          payload.kind === "permission" &&
          answer?.decision === "allow" &&
          answer.remember === "session"
            ? ("session" as const)
            : null,
        decidedByUserId:
          state === "answered" && typeof decider === "string" ? decider : null,
        closedReason:
          state !== "closed"
            ? null
            : row.expired
              ? ("expired" as const)
              : SESSION_ENDED_STATES.has(row.admissionState)
                ? ("session_closed" as const)
                : ("stale" as const),
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
      if (payload.kind === "permission" && typeof payload.tool === "string") {
        const input = payload.input ?? null;
        return {
          ...base,
          kind: "permission",
          tool: payload.tool,
          input,
          context: await toolSummaryContext(db, sessionId, payload.tool, input),
        };
      }
      const questions = pendingQuestionSchema
        .array()
        .safeParse(payload.questions);
      if (!questions.success) return null;
      // Only whether a typed answer was given: its text stays off the card.
      const answers =
        state === "answered" && Array.isArray(answer?.answers)
          ? answer.answers.flatMap((item) =>
              typeof item?.question_id === "string"
                ? [
                    {
                      question_id: item.question_id,
                      selected_option_ids: Array.isArray(
                        item.selected_option_ids,
                      )
                        ? item.selected_option_ids.filter(
                            (id): id is string => typeof id === "string",
                          )
                        : [],
                      typed:
                        typeof item.free_text === "string" &&
                        item.free_text !== "",
                    },
                  ]
                : [],
            )
          : [];
      return { ...base, kind: "question", questions: questions.data, answers };
    },

    async listOpen(ownerId, sessionId) {
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!session) return null;
      const rows = await db
        .select({
          requestId: pendingRequests.requestId,
          turnSequence: turns.sequence,
          attemptId: pendingRequests.attemptId,
          payload: pendingRequests.payload,
          createdAt: pendingRequests.createdAt,
          expiresAt: pendingRequests.expiresAt,
          parkAt: pendingRequests.parkAt,
          parkedAt: pendingRequests.parkedAt,
        })
        .from(pendingRequests)
        .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
        .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
        .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
        .where(actionablePendingWhere(sessionId))
        .orderBy(
          asc(pendingRequests.createdAt),
          asc(pendingRequests.requestId),
        );
      // The same line a Slack card shows; a GitHub tool's input holds only
      // ids, so the repository and branch come from the platform's rows.
      return Promise.all(
        rows.map(async (row) => {
          const item = publicPendingRequest(row);
          if (item.kind !== "permission") return item;
          const context = await toolSummaryContext(
            db,
            sessionId,
            item.tool,
            item.input,
          );
          return {
            ...item,
            summary: presentPendingRequest(item.tool, item.input, context),
          };
        }),
      );
    },

    answerAtomic(input: AnswerRequestInput): Promise<AnswerRequestResult> {
      const sessionId = input.sessionId.toLowerCase();
      const scope = {
        principal: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: ANSWER,
        resource: sessionId,
        key: input.idempotencyKey,
      };
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          // The receipt's current status: by now the worker may have
          // settled what the first call only stored.
          const [stored] = await tx
            .select({
              answeredBy: pendingRequests.answeredBy,
              surface: pendingRequests.answerSurface,
              decisionId: pendingRequests.answerDecisionId,
            })
            .from(pendingRequests)
            .where(eq(pendingRequests.answerReceiptId, existing.receiptId))
            .limit(1);
          const approval = stored ? approvalOf(stored) : undefined;
          return {
            outcome: "replayed",
            response: {
              receipt_id: existing.receiptId,
              receipt_status: existing.status,
              ...(approval ? { approval } : {}),
            },
          };
        }

        const requester = await lockRequester(
          tx,
          input.principal,
          "sessions:approve",
        );
        if (!requester) return { outcome: "actor_inactive" };
        // Session before pending row, the order the gateway paths take.
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, scope.principal),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        const agentKey = requester.keyAgentId !== null;
        if (
          agentKey &&
          !(await keyReaches(tx, requester, session.agentReleaseId))
        ) {
          return { outcome: "role" };
        }
        const reach = await lockSessionReach(tx, requester, session, {
          answer: !agentKey,
        });
        if (reach !== "ok") return { outcome: reach };
        const [pending] = await tx
          .select()
          .from(pendingRequests)
          .where(
            and(
              eq(pendingRequests.requestId, input.answer.request_id),
              eq(pendingRequests.sessionId, sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!pending) return { outcome: "not_found" };
        if (pending.answeredAt !== null) return { outcome: "expired" };

        const [last] = await tx
          .select({ sequence: max(pendingRequests.answerSequence) })
          .from(pendingRequests)
          .where(eq(pendingRequests.sessionId, sessionId));
        const sequence = (last?.sequence ?? 0) + 1;
        // Read last before the writes: a lease or TTL judged on an earlier
        // reading could lapse under the remaining reads and accept an
        // answer nobody can take.
        const at = await dbNow(tx);
        // Expiry first: by the time a request expires its attempt has
        // usually ended too, and the answer is late, not misdirected.
        if (pending.expiresAt.getTime() <= at.getTime()) {
          return { outcome: "expired" };
        }
        // The session row is locked, so nothing can move the epoch, the
        // lease or the turn while this reads them. A parked request is
        // answered whatever became of its asker: only expiry and
        // resolved_at stand in its way.
        const [asker] =
          pending.parkedAt !== null
            ? await tx
                .select({ turnSequence: turns.sequence })
                .from(turns)
                .where(eq(turns.id, pending.turnId))
                .limit(1)
            : await tx
                .select({ turnSequence: turns.sequence })
                .from(pendingRequests)
                .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
                .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
                .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
                .where(
                  and(
                    eq(pendingRequests.requestId, pending.requestId),
                    askerIsLive(at),
                  ),
                )
                .limit(1);
        // A fenced-out asker's requests are closed too, so this goes before
        // resolvedAt: they are stale, not expired.
        if (!asker) return { outcome: "stale" };
        if (pending.resolvedAt !== null) return { outcome: "expired" };
        const mismatch = answerMismatch(
          pending.payload as StoredPayload,
          input.answer,
        );
        if (mismatch !== null) return { outcome: "invalid", reason: mismatch };
        // Judged on every answer, not only the one that would close the
        // group: a resume refused at the last answer would leave the others
        // kept for a turn that cannot carry them on.
        if (pending.parkedAt !== null) {
          const unknown = await earliestUnknownTurn(tx, sessionId);
          if (
            unknown !== null ||
            session.admissionState === "recovery_required"
          ) {
            return { outcome: "recovery_required", unconfirmedTurnId: unknown };
          }
          // A stopped session resumes only onto a checkpoint that covers
          // every turn that ran, as its /resume judges.
          if (
            !hasRestorePoint(session) ||
            (session.admissionState === "stopped" &&
              contextGap(session, await contextCoverage(tx, session)))
          ) {
            return { outcome: "checkpoint_unavailable" };
          }
          // The turn that carries the group on is one input: the answers so
          // far, this one, and an expiry line for every other row must fit
          // it, or the group could never be carried on.
          const group = await tx
            .select()
            .from(pendingRequests)
            .where(
              and(
                eq(pendingRequests.turnId, pending.turnId),
                isNotNull(pendingRequests.parkedAt),
              ),
            )
            .orderBy(
              asc(pendingRequests.createdAt),
              asc(pendingRequests.requestId),
            );
          const carried = continuationMessage(
            group.map((row) =>
              row.requestId === pending.requestId
                ? { ...row, answer: input.answer }
                : row,
            ),
            false,
          );
          if (!sessionMessageSchema.safeParse({ message: carried }).success) {
            return {
              outcome: "invalid",
              reason:
                "The answers to this parked turn no longer fit in one message; answer with less text",
            };
          }
        }

        const waitingBefore = await inputWaitBefore(tx, session, at);
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: scope.principal,
          actor: scope.actor,
          requestId: scope.requestId,
          operation: ANSWER,
          targetRef: {
            session_id: sessionId,
            turn_id: String(asker.turnSequence),
            request_id: pending.requestId,
          },
          status: "accepted",
          result: null,
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(idempotencyKeys).values({
          principal: scope.principal,
          operation: ANSWER,
          resource: scope.resource,
          key: scope.key,
          payloadHash: input.payloadHash,
          receiptId,
        });
        await tx
          .update(pendingRequests)
          .set({
            answer: input.answer,
            answeredAt: at,
            resolvedAt: at,
            answerSequence: sequence,
            answerReceiptId: receiptId,
            answeredBy: scope.actor,
            answerSurface: input.approval.surface,
            answerDecisionId: input.approval.decisionId,
          })
          .where(eq(pendingRequests.requestId, pending.requestId));
        await announceInputWaitEnded(tx, {
          sessionId,
          waitingBefore,
          turnRowId: pending.turnId,
          at,
        });
        const parked =
          pending.parkedAt === null
            ? undefined
            : await closeParkedGroup(tx, session, {
                by: "answer",
                at,
                actor: scope.actor,
              });
        return {
          outcome: "accepted",
          response: {
            receipt_id: receiptId,
            receipt_status: "accepted",
            approval: {
              answered_by: scope.actor,
              surface: input.approval.surface,
              decision_id: input.approval.decisionId,
            },
            resumed: parked?.outcome === "ok" && parked.resumed,
            ...(parked === undefined ? {} : { waiting_for: parked.waitingFor }),
          },
        };
      });
    },

    async recordSelfApproval(input) {
      const id = randomUUID();
      await db.insert(receipts).values({
        id,
        ownerId: input.principal.ownerId,
        actor: receiptActorOf(input.principal),
        requestId: input.principal.requestId ?? null,
        operation: ANSWER,
        targetRef: {
          session_id: input.sessionId.toLowerCase(),
          turn_id: null,
          request_id: input.requestId,
        },
        status: "failed",
        result: {
          reason_code: "self_approval",
          decider_key: input.deciderKey,
        },
        error: {
          code: "FORBIDDEN",
          message:
            "The key that started this session cannot approve its requests",
        },
      });
      return id;
    },
  };
}

function approvalOf(row: {
  answeredBy: unknown;
  surface: string | null;
  decisionId: string | null;
}): ApprovalRecord | undefined {
  if (row.surface === null || row.decisionId === null) return undefined;
  return approvalRecordSchema.parse({
    answered_by: row.answeredBy,
    surface: row.surface,
    decision_id: row.decisionId,
  });
}
