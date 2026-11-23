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
 */
export async function budgetChoiceOfCall(
  db: Database,
  call: { exchangeId: string; sessionId: string; attemptId: string },
): Promise<{ choice: BudgetChoice | undefined; turnId: string | null }> {
  const [stored] = await db
    .select({
      rootKind: budgetReservations.rootKind,
      ownerKind: budgetAccounts.ownerKind,
      ownerId: budgetAccounts.ownerId,
    })
    .from(budgetReservations)
    .leftJoin(
      budgetAccounts,
      eq(budgetAccounts.id, budgetReservations.accountId),
    )
    .where(eq(budgetReservations.callId, call.exchangeId))
    .limit(1);
  const [opened] = stored
    ? []
    : await db
        .select({ exchangeId: providerExchanges.exchangeId })
        .from(providerExchanges)
        .where(eq(providerExchanges.exchangeId, call.exchangeId))
        .limit(1);
  const running = await db
    .select({
      sequence: turns.sequence,
      requesterKind: turns.requesterKind,
      requesterId: turns.requesterId,
      requesterAuth: turns.requesterAuth,
      workspaceId: sessions.workspaceId,
      teamId: sql<
        string | null
      >`CASE WHEN ${memberTeams.archivedAt} IS NULL THEN ${memberTeams.id} END`,
    })
    .from(turns)
    .innerJoin(sessions, eq(sessions.id, turns.sessionId))
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .leftJoin(agents, eq(agents.id, agentReleases.agentId))
    .leftJoin(memberTeams, eq(memberTeams.id, agents.managingTeamId))
    .where(
      and(
        eq(turns.sessionId, call.sessionId),
        eq(turns.attemptId, call.attemptId),
        eq(turns.status, "running"),
      ),
    )
    .limit(2);
  const [turn] = running;
  const turnId =
    running.length === 1 && turn !== undefined ? String(turn.sequence) : null;
  if (stored) {
    const owner =
      stored.ownerKind === "user" && stored.ownerId !== null
        ? { kind: "user" as const, userId: stored.ownerId }
        : stored.ownerKind === "team" && stored.ownerId !== null
          ? { kind: "team" as const, teamId: stored.ownerId }
          : null;
    return { choice: { rootKind: stored.rootKind, owner }, turnId };
  }
  // Opened on the session's limit alone: so its replays are too.
  if (opened) return { choice: undefined, turnId };
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
