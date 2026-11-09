import {
  MESSAGE_MAX_BYTES,
  type ParkedDelivery,
  type PendingQuestion,
  type PostSessionAnswerRequest,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { WorkerFence } from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { enqueueEndedIntentNotices } from "./action-notices.ts";
import { dbNow } from "./db-clock.ts";
import { enqueueWithin } from "./enqueue.ts";
import { cancelParkedRequests } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { moveToResuming } from "./resume-control.ts";
import {
  pendingRequests,
  permissionGrants,
  pushIntents,
  receipts,
  sessions,
  turnContinuations,
  turns,
} from "./schema.ts";
import { recordInputWaitStage } from "./session-events.ts";

type SessionRow = typeof sessions.$inferSelect;
type GroupRow = typeof pendingRequests.$inferSelect;

/**
 * Who closes a parked group. `answer`, `interrupt` (another group
 * cancelled), `expiry` and `execution_gone` are the platform undoing its
 * own park, so they resume only a session the park
 * still holds; `resume` is a person with control rights, who may carry on a
 * pause they took over; `close` ends the group unresumed.
 */
export type ParkedGroupCaller =
  | "answer"
  | "interrupt"
  | "expiry"
  | "execution_gone"
  | "resume"
  | "close";

export type ParkedGroupResult =
  | { outcome: "ok"; resumed: boolean; waitingFor: number }
  | { outcome: "pending_requests_open"; waitingFor: number };

// A turn already carried on, or whose requests a close cancelled, is no
// group any more.
function uncontinued(sessionId: string) {
  return and(
    eq(pendingRequests.sessionId, sessionId),
    isNotNull(pendingRequests.parkedAt),
    or(
      isNull(pendingRequests.settledOutcome),
      sql`${pendingRequests.settledOutcome} <> 'cancelled'`,
    ),
    notExists(
      sql`(SELECT 1 FROM ${turnContinuations} c WHERE c.parked_turn_id = ${pendingRequests.turnId})`,
    ),
  );
}

/**
 * The session's parked turns still waiting to be carried on, oldest first,
 * each with its rows. A drain-parked turn can stay open while a later one
 * parks too, and an answer to either closes its own.
 */
export async function openParkedGroups(
  tx: Database,
  sessionId: string,
): Promise<{ turnRowId: number; rows: GroupRow[] }[]> {
  const open = await tx
    .selectDistinct({ turnId: pendingRequests.turnId })
    .from(pendingRequests)
    .where(uncontinued(sessionId))
    .orderBy(asc(pendingRequests.turnId));
  const groups = [];
  for (const { turnId } of open) {
    const rows = await tx
      .select()
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.sessionId, sessionId),
          eq(pendingRequests.turnId, turnId),
          isNotNull(pendingRequests.parkedAt),
        ),
      )
      .orderBy(asc(pendingRequests.createdAt), asc(pendingRequests.requestId))
      .for("update");
    groups.push({ turnRowId: turnId, rows });
  }
  return groups;
}

function waitingIn(rows: GroupRow[], at: Date): number {
  return rows.filter(
    (row) =>
      row.answeredAt === null &&
      row.resolvedAt === null &&
      row.expiresAt.getTime() > at.getTime(),
  ).length;
}

/**
 * Parked requests whose deadline passed unanswered: closed and settled as
 * expired, which is a denial, in one write with the `input_wait` record
 * that says so. Nobody is left to settle them otherwise.
 */
export async function expireLapsedParked(
  tx: Database,
  input: { sessionId: string; turnRowId?: number; at: Date },
): Promise<string[]> {
  const expired = await tx
    .update(pendingRequests)
    .set({
      resolvedAt: input.at,
      settledAt: input.at,
      settledOutcome: "expired",
    })
    .where(
      and(
        eq(pendingRequests.sessionId, input.sessionId),
        input.turnRowId === undefined
          ? undefined
          : eq(pendingRequests.turnId, input.turnRowId),
        isNotNull(pendingRequests.parkedAt),
        isNull(pendingRequests.answeredAt),
        isNull(pendingRequests.resolvedAt),
        lte(pendingRequests.expiresAt, input.at),
      ),
    )
    .returning({
      requestId: pendingRequests.requestId,
      turnId: pendingRequests.turnId,
    });
  const ids = expired.map((row) => row.requestId).sort();
  const turnIds = new Set(expired.map((row) => row.turnId));
  await recordInputWaitStage(tx, {
    sessionId: input.sessionId,
    stage: "expired",
    requestIds: ids,
    turnRowId: turnIds.size === 1 ? ([...turnIds][0] ?? null) : null,
    now: input.at,
  });
  return ids;
}

/**
 * The one place a parked group closes. Once none of its requests is still
 * open and at least one was answered, the turn that carries on with the
 * answers is queued behind what the session already holds (turns run in
 * sequence order, which checkpoint coverage relies on), its allows become
 * grants, and a session the park paused goes `resuming` once no group is
 * left. A group that only expired under a pause stays as it is until a
 * person resumes it. The caller holds the session row lock.
 */
export async function closeParkedGroup(
  tx: Database,
  session: Pick<SessionRow, "id">,
  input: { by: "close"; at: Date },
): Promise<ParkedGroupResult>;
export async function closeParkedGroup(
  tx: Database,
  session: SessionRow,
  input: {
    by: Exclude<ParkedGroupCaller, "close">;
    at: Date;
    // Who the resume is recorded for: the answer's actor, or else whoever
    // answered last.
    actor?: ReceiptActor | null;
  },
): Promise<ParkedGroupResult>;
export async function closeParkedGroup(
  tx: Database,
  target: SessionRow | Pick<SessionRow, "id">,
  input: { by: ParkedGroupCaller; at: Date; actor?: ReceiptActor | null },
): Promise<ParkedGroupResult> {
  if (input.by === "close") {
    await cancelParkedRequests(tx, { sessionId: target.id }, input.at);
    return { outcome: "ok", resumed: false, waitingFor: 0 };
  }
  // Every other caller passes the whole row (the overloads above).
  const session = target as SessionRow;
  const groups = await openParkedGroups(tx, session.id);
  const waiting = groups.map((group) => waitingIn(group.rows, input.at));
  const waitingFor = waiting.reduce((sum, count) => sum + count, 0);
  if (input.by === "resume") {
    if (waitingFor > 0) return { outcome: "pending_requests_open", waitingFor };
    for (const group of groups) {
      await continueParkedTurn(tx, session, group, input.at);
    }
    return { outcome: "ok", resumed: groups.length > 0, waitingFor: 0 };
  }
  const parkedBySystem =
    session.admissionState === "paused" &&
    session.pauseReason === "awaiting_input";
  // A drain park leaves no pause: the session stayed active and only needs
  // the turn. A person's pause, or one still draining, is not this call's
  // to end; the drain's own exit closes the group once it is paused.
  if (!(parkedBySystem || session.admissionState === "active")) {
    return { outcome: "ok", resumed: false, waitingFor };
  }
  let continued = 0;
  let lastAnswered: GroupRow | undefined;
  for (const [index, group] of groups.entries()) {
    const answered = group.rows
      .filter((row) => row.answeredAt !== null)
      .sort((a, b) => (a.answerSequence ?? 0) - (b.answerSequence ?? 0));
    if (waiting[index] !== 0) continue;
    // A pause holds an all-expired group for a person's resume; a drain
    // park has no pause to resume, so it carries on with the denials.
    if (answered.length === 0 && parkedBySystem) continue;
    await continueParkedTurn(tx, session, group, input.at);
    continued += 1;
    lastAnswered = answered.at(-1) ?? lastAnswered;
  }
  if (!parkedBySystem) {
    return { outcome: "ok", resumed: continued > 0, waitingFor };
  }
  // The pause lifts only once no group it holds is left, and only for a
  // turn to carry on: one carried earlier may be waiting on a group that a
  // cancel, not an answer, took away.
  if (
    continued < groups.length ||
    (continued === 0 && !(await continuationQueued(tx, session.id)))
  ) {
    return { outcome: "ok", resumed: false, waitingFor };
  }
  await moveToResuming(tx, session, {
    now: input.at,
    answeredBy:
      input.actor ??
      (lastAnswered?.answeredBy as ReceiptActor | null | undefined) ??
      null,
  });
  return { outcome: "ok", resumed: true, waitingFor };
}

async function continuationQueued(
  tx: Database,
  sessionId: string,
): Promise<boolean> {
  const [queued] = await tx
    .select({ turnId: turnContinuations.turnId })
    .from(turnContinuations)
    .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
    .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "queued")))
    .limit(1);
  return queued !== undefined;
}

async function continueParkedTurn(
  tx: Database,
  session: SessionRow,
  group: { turnRowId: number; rows: GroupRow[] },
  at: Date,
) {
  await expireLapsedParked(tx, {
    sessionId: session.id,
    turnRowId: group.turnRowId,
    at,
  });
  const message = continuationMessage(group.rows);
  const [parkedTurn] = await tx
    .select({ sequence: turns.sequence, actorId: turns.actorId })
    .from(turns)
    .where(eq(turns.id, group.turnRowId));
  const parkedSequence = parkedTurn?.sequence ?? 0;
  // A turn counts when it ran or still will: one cancelled or failed before
  // it started (a revoked continuation, a launch given up on) left nothing,
  // and a continuation of this very group is the turn taking over.
  const [intervening] = await tx
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, session.id),
        gt(turns.sequence, parkedSequence),
        or(
          isNotNull(turns.attemptId),
          notInArray(turns.status, ["cancelled", "failed"]),
        ),
        notExists(
          sql`(SELECT 1 FROM ${turnContinuations} c WHERE c.turn_id = ${turns.id} AND c.parked_turn_id = ${group.turnRowId})`,
        ),
      ),
    )
    .limit(1);
  const [last] = await tx
    .select({ sequence: max(turns.sequence) })
    .from(turns)
    .where(eq(turns.sessionId, session.id));
  const [turn] = await tx
    .insert(turns)
    .values({
      sessionId: session.id,
      sequence: (last?.sequence ?? 0) + 1,
      message,
      status: "queued",
      createdAt: sql`clock_timestamp()`,
      // The continuation is the parked turn going on, so it keeps whoever
      // made that request; the person who answered did not.
      actorId: parkedTurn?.actorId ?? null,
    })
    .returning({ id: turns.id });
  if (!turn) throw new Error("Failed to insert the continuing turn");
  await tx
    .insert(turnContinuations)
    .values({ turnId: turn.id, parkedTurnId: group.turnRowId });
  await carryPushIntents(tx, {
    parkedTurnRowId: group.turnRowId,
    continuationRowId: turn.id,
    // A turn between the park and this one may have left its own commits.
    intervened: intervening !== undefined,
  });
  await enqueueWithin(tx, {
    sessionId: session.id,
    turnId: turn.id,
    payload: { message },
  });
  const allows = group.rows.filter((row) => isAllow(row.answer));
  if (allows.length > 0) {
    await tx.insert(permissionGrants).values(
      allows.map((row) => ({
        requestId: row.requestId,
        sessionId: session.id,
        turnId: turn.id,
      })),
    );
  }
}

/**
 * The pushes a parked turn asked to make when it ended stay deferred through
 * the park. The turn that carries it on takes them over and pins them at its
 * own end, whose checkpoint holds the parked turn's commits. When another
 * turn runs first, that checkpoint would hold work the push never asked
 * for, so they end as superseded, visible in the intent list.
 */
async function carryPushIntents(
  tx: Database,
  input: {
    parkedTurnRowId: number;
    continuationRowId: number;
    intervened: boolean;
  },
) {
  const held = and(
    eq(pushIntents.turnId, input.parkedTurnRowId),
    eq(pushIntents.status, "deferred"),
  );
  const rows = await tx
    .update(pushIntents)
    .set(
      input.intervened
        ? {
            status: "cancelled",
            refusalCode: "superseded_by_turn",
            settledAt: sql`now()`,
            updatedAt: sql`now()`,
          }
        : { turnId: input.continuationRowId, updatedAt: sql`now()` },
    )
    .where(held)
    .returning({ id: pushIntents.id });
  if (input.intervened) {
    await enqueueEndedIntentNotices(
      tx,
      rows.map((row) => row.id),
    );
  }
}

function isAllow(answer: unknown): boolean {
  const parsed = answer as PostSessionAnswerRequest | null;
  return parsed?.kind === "permission" && parsed.decision === "allow";
}

type StoredPayload =
  | { kind: "permission"; tool: string }
  | { kind: "question"; questions: PendingQuestion[] };

/**
 * What the turn that carries on is told. The engine's own wait was cut, so
 * the model learns the outcome from this and calls again; an allow is then
 * met by its grant. Built from the stored display copy: the arguments are
 * already in the engine's transcript and need no repeating.
 */
export function continuationMessage(rows: GroupRow[], cut = true): string {
  const lines = rows.map((row) => {
    const payload = row.payload as StoredPayload;
    const answer = row.answer as PostSessionAnswerRequest | null;
    const tool = payload.kind === "permission" ? payload.tool : row.tool;
    if (answer === null) {
      return payload.kind === "permission"
        ? `- Your ${tool} call: nobody answered before it expired, so it is denied.`
        : "- Your question: nobody answered before it expired.";
    }
    if (answer.kind === "permission") {
      return answer.decision === "allow"
        ? `- Your ${tool} call: allowed. The allow is used by the next identical call.`
        : `- Your ${tool} call: denied.${answer.reason === undefined ? "" : ` Reason: ${answer.reason}`}`;
    }
    const questions = payload.kind === "question" ? payload.questions : [];
    return answer.answers
      .map((item) => {
        const question = questions.find(
          (candidate) => candidate.question_id === item.question_id,
        );
        const chosen = item.selected_option_ids.map(
          (id) =>
            question?.options.find((option) => option.option_id === id)
              ?.label ?? id,
        );
        const parts = [
          ...chosen,
          ...(item.free_text === undefined ? [] : [item.free_text]),
        ];
        return `- ${question?.prompt ?? item.question_id}: ${parts.join("; ")}`;
      })
      .join("\n");
  });
  const head =
    "Your previous turn was stopped while it waited for a person. Their answers to what it asked:";
  return [
    head,
    ...(cut ? fitted(lines, MESSAGE_MAX_BYTES - bytes(`${head}\n`)) : lines),
  ].join("\n");
}

const utf8 = new TextEncoder();

function bytes(text: string): number {
  return utf8.encode(text).length;
}

// An answer is refused when it would not fit, but answers stored before
// their turn parked were never judged: past the limit every line gets an
// equal share, so the group still carries on, the long answers cut.
function fitted(lines: string[], budget: number): string[] {
  const joined = lines.join("\n");
  if (bytes(joined) <= budget) return lines;
  const mark = " [cut to fit]";
  const share = Math.floor((budget - (lines.length - 1)) / lines.length);
  return lines.map((line) => {
    if (bytes(line) <= share) return line;
    let cut = "";
    let used = bytes(mark);
    for (const char of line) {
      used += bytes(char);
      if (used > share) break;
      cut += char;
    }
    return cut + mark;
  });
}

/**
 * The turn that carries on a park was handed to a worker: the answers its
 * input states (a question's, a denial, an expiry) have reached the engine,
 * and their receipts settle. An allow settles when its grant is spent or
 * left unused.
 */
export async function settleContinuationInputs(
  tx: Database,
  input: { parkedTurnRowId: number; at: Date },
) {
  const rows = await tx
    .select({
      requestId: pendingRequests.requestId,
      answer: pendingRequests.answer,
      receiptId: pendingRequests.answerReceiptId,
    })
    .from(pendingRequests)
    .where(
      and(
        eq(pendingRequests.turnId, input.parkedTurnRowId),
        isNotNull(pendingRequests.parkedAt),
        isNotNull(pendingRequests.answeredAt),
        isNull(pendingRequests.settledAt),
      ),
    )
    .for("update");
  const carried = rows.filter((row) => !isAllow(row.answer));
  if (carried.length === 0) return;
  await tx
    .update(pendingRequests)
    .set({ settledAt: input.at, settledOutcome: "answered" })
    .where(
      inArray(
        pendingRequests.requestId,
        carried.map((row) => row.requestId),
      ),
    );
  const receiptIds = carried.flatMap((row) =>
    row.receiptId === null ? [] : [row.receiptId],
  );
  if (receiptIds.length === 0) return;
  await tx
    .update(receipts)
    .set({ status: "succeeded", error: null, updatedAt: input.at })
    .where(
      and(inArray(receipts.id, receiptIds), eq(receipts.status, "accepted")),
    );
}

/**
 * The parked requests a delivery report may settle: those whose turn is
 * carried on by a turn the reporting attempt was handed, and no others.
 */
export async function lockDeliveredParked(
  tx: Database,
  input: { fence: WorkerFence; requestIds: string[] },
): Promise<GroupRow[]> {
  return tx
    .select({ row: pendingRequests })
    .from(pendingRequests)
    .innerJoin(
      turnContinuations,
      eq(turnContinuations.parkedTurnId, pendingRequests.turnId),
    )
    .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
    .where(
      and(
        eq(pendingRequests.sessionId, input.fence.sessionId),
        inArray(pendingRequests.requestId, input.requestIds),
        isNotNull(pendingRequests.parkedAt),
        eq(turns.attemptId, input.fence.attemptId),
      ),
    )
    .orderBy(asc(pendingRequests.requestId))
    .for("update", { of: pendingRequests })
    .then((rows) => rows.map(({ row }) => row));
}

/**
 * What the turn carrying a park on reported of its answers. A spent grant
 * delivered the allow; one the turn ended without spending did nothing,
 * since the model never made that call again. The first word on a request
 * stands, so a resent report changes nothing.
 */
export async function settleParkedDeliveries(
  tx: Database,
  input: { rows: GroupRow[]; delivered: ParkedDelivery[]; at: Date },
) {
  const byId = new Map(input.rows.map((row) => [row.requestId, row]));
  for (const item of input.delivered) {
    const row = byId.get(item.request_id);
    if (!row || row.settledAt !== null || row.answeredAt === null) continue;
    const allow = isAllow(row.answer);
    if (item.outcome !== "input_delivered" && !allow) continue;
    await tx
      .update(pendingRequests)
      .set({
        settledAt: input.at,
        settledOutcome: "answered",
        settledAnswerResult:
          item.outcome === "grant_consumed" ? "applied" : null,
      })
      .where(eq(pendingRequests.requestId, row.requestId));
    row.settledAt = input.at;
    if (item.outcome === "grant_consumed") {
      await tx
        .update(permissionGrants)
        .set({ consumedAt: input.at })
        .where(
          and(
            eq(permissionGrants.requestId, row.requestId),
            isNull(permissionGrants.consumedAt),
          ),
        );
    }
    if (row.answerReceiptId === null) continue;
    await tx
      .update(receipts)
      .set({
        ...(item.outcome === "grant_unused"
          ? {
              status: "failed" as const,
              error: {
                code: "REQUEST_STALE",
                message:
                  "the turn that resumed the park ended without making the allowed call again, so the allow was not used",
              },
            }
          : { status: "succeeded" as const, error: null }),
        updatedAt: input.at,
      })
      .where(
        and(
          eq(receipts.id, row.answerReceiptId),
          eq(receipts.status, "accepted"),
        ),
      );
  }
}

/**
 * The execution that ran the turn carrying a park on is gone without saying
 * whether it spent the allows it was handed: the call may have run, so
 * their receipts end unknown, as an undelivered answer's do.
 */
export async function abandonUndeliveredParked(
  tx: Database,
  sessionId: string,
  now: Date,
) {
  const rows = await tx
    .select({
      requestId: pendingRequests.requestId,
      receiptId: pendingRequests.answerReceiptId,
    })
    .from(pendingRequests)
    .innerJoin(
      turnContinuations,
      eq(turnContinuations.parkedTurnId, pendingRequests.turnId),
    )
    .innerJoin(turns, eq(turns.id, turnContinuations.turnId))
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        isNotNull(pendingRequests.parkedAt),
        isNotNull(pendingRequests.answeredAt),
        isNull(pendingRequests.settledAt),
        isNotNull(turns.attemptId),
      ),
    )
    .for("update", { of: pendingRequests });
  if (rows.length === 0) return;
  await tx
    .update(pendingRequests)
    .set({ settledAt: now, settledOutcome: "lost" })
    .where(
      inArray(
        pendingRequests.requestId,
        rows.map((row) => row.requestId),
      ),
    );
  const receiptIds = rows.flatMap((row) =>
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
          "the execution ended before confirming whether the resumed turn used the allow",
      },
      updatedAt: now,
    })
    .where(
      and(inArray(receipts.id, receiptIds), eq(receipts.status, "accepted")),
    );
}

/**
 * The reconciler's pass over parked requests whose deadline passed with no
 * worker left to deny them: each is settled expired and its group closed,
 * which carries the turn on when another request of it was answered.
 * Returns the sessions it touched.
 */
export async function expireParkedGroups(
  db: Database,
  options: { limit: number; dryRun: boolean },
): Promise<string[]> {
  const candidates = await db
    .selectDistinct({ sessionId: pendingRequests.sessionId })
    .from(pendingRequests)
    .where(
      and(
        isNotNull(pendingRequests.parkedAt),
        isNull(pendingRequests.answeredAt),
        isNull(pendingRequests.resolvedAt),
        lte(pendingRequests.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(options.limit);
  if (options.dryRun) return candidates.map((row) => row.sessionId);
  const touched: string[] = [];
  for (const { sessionId } of candidates) {
    const expired = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .for("update");
      if (!session) return false;
      const at = await dbNow(tx);
      const ids = await expireLapsedParked(tx, { sessionId, at });
      if (ids.length === 0) return false;
      await closeParkedGroup(tx, session, { by: "expiry", at });
      return true;
    });
    if (expired) touched.push(sessionId);
  }
  return touched;
}
