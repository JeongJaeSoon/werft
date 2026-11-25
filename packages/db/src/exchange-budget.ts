import {
  BUDGET_ACCOUNT_REFUSED_EVENT_CODE,
  BUDGET_OWNER_KIND_VALUES,
  type BudgetOwnerKind,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import {
  type BudgetChoice,
  type BudgetRoot,
  budgetRootOfTurn,
  chooseBudgetAccount,
} from "@werft-ai/platform";
import {
  type AnyColumn,
  and,
  desc,
  eq,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { dbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  budgetAccounts,
  budgetReservations,
  events,
  memberTeams,
  providerExchanges,
  sessions,
  turns,
} from "./schema.ts";
import { recordEvent } from "./sessions/session-events.ts";

/**
 * The running turn a provider call of this attempt serves (its public
 * turn_id, for the log of a refusal), and the budget account it is held on: chosen by
 * the root of the turn the attempt is running, the team being the agent's
 * managing team while it is not archived. A call no running turn serves (a
 * title call, a call between turns) is the session's, charged as the
 * session's first turn, the one that created it. Undefined, the call is held
 * on the session's limit alone, as before accounts: a session with no
 * workspace, more than one running turn, or a turn whose requester says
 * nothing budgetRootOfTurn can read. An exchange already
 * opened keeps the account its first open chose, whichever turn runs now.
 * A replay read before the first open commits chooses from the turn as
 * this snapshot has it; the ledger's lock then compares, and a turn changed
 * in between is a conflict, never a second account. The proxy sends an
 * exchange's open once.
 */
export async function budgetChoiceOfCall(
  db: Database,
  call: {
    exchangeId: string;
    sessionId: string;
    attemptId: string;
    /** A session title call: the session's, whichever turn runs now. */
    title?: boolean;
  },
): Promise<{ choice: BudgetChoice | undefined; turnId: string | null }> {
  // One statement, so one snapshot: an open commits its exchange row and
  // its reservation together, and this sees both or neither.
  const id = call.exchangeId;
  const rows = await db
    .select({
      storedRootKind: sql<BudgetChoice["rootKind"] | null>`(
        SELECT ${budgetReservations.rootKind} FROM ${budgetReservations}
        WHERE ${budgetReservations.callId} = ${id})`,
      storedOwnerKind: sql<"user" | "team" | null>`(
        SELECT ${budgetAccounts.ownerKind} FROM ${budgetReservations}
        JOIN ${budgetAccounts} ON ${budgetAccounts.id} = ${budgetReservations.accountId}
        WHERE ${budgetReservations.callId} = ${id})`,
      storedOwnerId: sql<string | null>`(
        SELECT ${budgetAccounts.ownerId} FROM ${budgetReservations}
        JOIN ${budgetAccounts} ON ${budgetAccounts.id} = ${budgetReservations.accountId}
        WHERE ${budgetReservations.callId} = ${id})`,
      opened: sql<boolean>`EXISTS (
        SELECT 1 FROM ${providerExchanges}
        WHERE ${providerExchanges.exchangeId} = ${id})`,
      sequence: turns.sequence,
      requesterKind: turns.requesterKind,
      requesterId: turns.requesterId,
      requesterAuth: turns.requesterAuth,
      ...firstTurnColumns(call.sessionId),
      workspaceId: sessions.workspaceId,
      teamId: sql<
        string | null
      >`CASE WHEN ${memberTeams.archivedAt} IS NULL THEN ${memberTeams.id} END`,
    })
    .from(sessions)
    .leftJoin(
      turns,
      and(
        eq(turns.sessionId, sessions.id),
        eq(turns.attemptId, call.attemptId),
        eq(turns.status, "running"),
      ),
    )
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .leftJoin(agents, eq(agents.id, agentReleases.agentId))
    .leftJoin(memberTeams, eq(memberTeams.id, agents.managingTeamId))
    .where(eq(sessions.id, call.sessionId))
    .limit(2);
  const [first] = rows;
  if (first === undefined) return { choice: undefined, turnId: null };
  const running = rows.filter((row) => row.sequence !== null);
  const [turn] = running;
  const turnId =
    running.length === 1 && turn !== undefined ? String(turn.sequence) : null;
  if (first.storedRootKind !== null) {
    const ownerId = first.storedOwnerId;
    const owner =
      ownerId === null
        ? null
        : first.storedOwnerKind === "user"
          ? { kind: "user" as const, userId: ownerId }
          : { kind: "team" as const, teamId: ownerId };
    return { choice: { rootKind: first.storedRootKind, owner }, turnId };
  }
  // Opened on the session's limit alone: so its replays are too.
  if (first.opened) return { choice: undefined, turnId };
  if (first.workspaceId === null) return { choice: undefined, turnId };
  const ofRoot = (root: BudgetRoot | null) =>
    root === null ? undefined : chooseBudgetAccount(root, first.teamId);
  if (call.title === true || running.length === 0) {
    return {
      choice: ofRoot(
        budgetRootOfTurn({
          requesterKind: first.firstRequesterKind,
          requesterId: first.firstRequesterId,
          requesterAuth: first.firstRequesterAuth,
        }),
      ),
      turnId: null,
    };
  }
  if (turnId === null || turn === undefined) {
    return { choice: undefined, turnId: null };
  }
  return { choice: ofRoot(budgetRootOfTurn(turn)), turnId };
}

// The requester of the session's first turn: who created it.
function firstTurnColumns(sessionId: string) {
  const first = (column: AnyColumn) => sql`(
    SELECT ${column} FROM ${turns}
    WHERE ${turns.sessionId} = ${sessionId}::uuid AND ${turns.sequence} = 1)`;
  return {
    firstRequesterKind: first(turns.requesterKind) as SQL<string | null>,
    firstRequesterId: first(turns.requesterId) as SQL<string | null>,
    firstRequesterAuth: first(turns.requesterAuth) as SQL<unknown>,
  };
}

/**
 * The session's record that a budget account refused one of its provider
 * calls: an `error` event with code BUDGET_EXCEEDED and whose account it
 * was, on the turn the call was chosen for (`turnId`, the public id
 * budgetChoiceOfCall read; null for a call no single turn serves), even if
 * that turn has ended since. The session's attention reads it, and so does
 * the turn's Slack notice (unansweredTurns). Written once per turn, or once
 * per attempt for calls no turn serves: the engine retrying the refused
 * call adds nothing. The agent's own work with no team to charge is the
 * team's.
 */
export async function recordBudgetAccountRefusal(
  db: Database,
  input: {
    sessionId: string;
    attemptId: string;
    turnId: string | null;
    owner: BudgetOwnerKind | null;
  },
): Promise<"recorded" | "recorded_before" | "no_session"> {
  const owner = input.owner ?? "team";
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for("update");
    if (session === undefined) return "no_session";
    const sequence = input.turnId === null ? null : Number(input.turnId);
    const [turn] =
      sequence === null || !Number.isSafeInteger(sequence)
        ? []
        : await tx
            .select({ id: turns.id })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, input.sessionId),
                eq(turns.sequence, sequence),
              ),
            )
            .limit(1);
    const turnRowId = turn?.id ?? null;
    const [before] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.sessionId, input.sessionId),
          budgetAccountRefusalEvent(),
          turnRowId === null
            ? and(isNull(events.turnId), eq(events.attemptId, input.attemptId))
            : eq(events.turnId, turnRowId),
        ),
      )
      .limit(1);
    if (before !== undefined) return "recorded_before";
    await recordEvent(tx, {
      sessionId: input.sessionId,
      type: "error",
      payload: {
        code: BUDGET_ACCOUNT_REFUSED_EVENT_CODE,
        message:
          SLACK_NOTICE_MESSAGES.en[
            owner === "user" ? "budgetAccountUser" : "budgetAccountTeam"
          ],
        budget_owner: owner,
      },
      turnRowId,
      attemptId: input.attemptId,
      now: await dbNow(tx),
    });
    return "recorded";
  });
}

/** An `error` event recordBudgetAccountRefusal wrote. */
function budgetAccountRefusalEvent(): SQL | undefined {
  return and(
    eq(events.type, "error"),
    sql`${events.payload}->>'code' = ${BUDGET_ACCOUNT_REFUSED_EVENT_CODE}`,
    sql`${events.payload} ? 'budget_owner'`,
  );
}

/** The id of the last event of the session's last completed turn, or 0. */
function lastCompletedTurnEventId(sessionId: string): SQL {
  return sql`coalesce((
    SELECT max(e.id) FROM ${events} e
    WHERE e.session_id = ${sessionId}::uuid AND e.turn_id = (
      SELECT t.id FROM ${turns} t
      WHERE t.session_id = ${sessionId}::uuid AND t.status = 'completed'
      ORDER BY t.sequence DESC LIMIT 1)), 0)`;
}

const BUDGET_OWNERS: ReadonlySet<string> = new Set(BUDGET_OWNER_KIND_VALUES);

/**
 * Whose budget account refused the session's latest recorded call since its
 * last completed turn, or null: a completed turn shows its calls go through
 * again. Bounded by the id of that turn's last event, so the read scans
 * only the events after it.
 */
export async function budgetAccountRefused(
  tx: Database,
  sessionId: string,
): Promise<BudgetOwnerKind | null> {
  const [row] = await tx
    .select({ owner: sql<string | null>`${events.payload}->>'budget_owner'` })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        sql`${events.id} > ${lastCompletedTurnEventId(sessionId)}`,
        budgetAccountRefusalEvent(),
      ),
    )
    .orderBy(desc(events.id))
    .limit(1);
  const owner = row?.owner ?? null;
  return owner !== null && BUDGET_OWNERS.has(owner)
    ? (owner as BudgetOwnerKind)
    : null;
}
