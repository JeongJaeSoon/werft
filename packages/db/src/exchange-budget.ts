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
  memberTeams,
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
 * requester says nothing budgetRootOfTurn can read.
 */
export async function budgetChoiceOfCall(
  db: Database,
  call: { sessionId: string; attemptId: string },
): Promise<{ choice: BudgetChoice | undefined; turnId: string | null }> {
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
  if (running.length !== 1 || turn === undefined) {
    return { choice: undefined, turnId: null };
  }
  const turnId = String(turn.sequence);
  if (turn.workspaceId === null) return { choice: undefined, turnId };
  const root = budgetRootOfTurn(turn);
  return {
    choice: root === null ? undefined : chooseBudgetAccount(root, turn.teamId),
    turnId,
  };
}
