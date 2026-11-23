import {
  type BudgetChoice,
  budgetRootOfTurn,
  chooseBudgetAccount,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  budgetAccounts,
  budgetReservations,
  memberTeams,
  providerExchanges,
  sessions,
  turns,
} from "./schema.ts";

/**
 * The running turn a provider call of this attempt serves (its public
 * turn_id, for the log of a refusal), and the budget account it is held on: chosen by
 * the root of the turn the attempt is running, the team being the agent's
 * managing team while it is not archived. Undefined, the call is held on
 * the session's limit alone, as before accounts: no running turn (a title
 * call, a call between turns), a session with no workspace, or a turn whose
 * requester says nothing budgetRootOfTurn can read. An exchange already
 * opened keeps the account its first open chose, whichever turn runs now.
 * A replay read before the first open commits chooses from the turn as
 * this snapshot has it; the ledger's lock then compares, and a turn changed
 * in between is a conflict, never a second account. The proxy sends an
 * exchange's open once.
 */
export async function budgetChoiceOfCall(
  db: Database,
  call: { exchangeId: string; sessionId: string; attemptId: string },
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
  if (turnId === null || turn === undefined) {
    return { choice: undefined, turnId: null };
  }
  if (turn.workspaceId === null) return { choice: undefined, turnId };
  const root = budgetRootOfTurn(turn);
  return {
    choice: root === null ? undefined : chooseBudgetAccount(root, turn.teamId),
    turnId,
  };
}
