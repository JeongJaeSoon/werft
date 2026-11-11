import type { AgentUsageScope } from "@werft-ai/contracts";
import {
  type AgentUsageState,
  type AgentUsageStore,
  decideUsage,
  type PutAgentUsageResult,
  type UsageDecision,
  type UsageFacts,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  agentUsage,
  agentUsageTargets,
  memberTeamMembers,
  memberTeams,
  receipts,
} from "../schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The edit takes rows in the order the notes' P1.6c gives (see also the list
// in requester-locks.ts): user → membership → agent → agent_usage → admin rows
// → every team it reads (id order) → relation rows → the actor's member rows.
// A team's archive takes agent_usage before the team, so the two meet in that
// order and one waits for the other.

type Reader = Pick<Database, "select">;

type Lockable<R> = PromiseLike<R> & {
  for(strength: "share"): PromiseLike<R>;
};

const MANAGERS: readonly string[] = ["owner", "admin"];

/**
 * Whether `who` may use the agent, as of this read, or as of these locks
 * (94S-901). One function for both so the policy's answer and the store's
 * re-decision cannot differ. With `lock`, rows are taken FOR SHARE in the
 * order of the notes' P1.6c, in one pass and never through another helper:
 * agent → agent_usage → admin rows → every team it reads (id order) →
 * relation rows → the requester's member rows. The caller holds the user,
 * membership, key and session rows already, which come before the agent.
 * A team's archive and an edit of the usage take the agent_usage row first,
 * so each waits for this transaction or is seen by it.
 */
export async function usageOf(
  tx: Reader,
  input: {
    workspaceId: string;
    agentId: string;
    who: {
      userId: string | null;
      role: string | null;
      keyAgentId: string | null;
    };
    lock: boolean;
  },
): Promise<UsageDecision> {
  const { workspaceId, agentId, who, lock } = input;
  const run = <R>(query: Lockable<R>): PromiseLike<R> =>
    lock ? query.for("share") : query;
  const [agent] = await run(
    tx
      .select({ managingTeamId: agents.managingTeamId })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId))),
  );
  if (!agent) return { allowed: false };
  // An agent made by hand without its row reads as the default it would get.
  const [usage] = await run(
    tx
      .select({ scope: agentUsage.scope })
      .from(agentUsage)
      .where(eq(agentUsage.agentId, agentId)),
  );
  const scope = (usage?.scope ?? "workspace") as AgentUsageScope;
  const agentKey =
    who.keyAgentId !== null && who.keyAgentId.toLowerCase() === agentId;
  const facts: UsageFacts = {
    scope,
    agentKey,
    personless: who.userId === null,
    workspaceManager: who.role !== null && MANAGERS.includes(who.role),
    directAdmin: false,
    usageTeams: [],
    adminTeams: [],
    managingLead: null,
    managingMember: null,
  };
  if (agentKey || scope === "workspace" || who.userId === null) {
    return decideUsage(facts);
  }
  const userId = who.userId.toLowerCase();

  // The usage row is held, so its targets and the admin rows cannot move
  // under the reads below; the agent row is held too (admin and managing-team
  // changes take it first).
  const [direct] = await run(
    tx
      .select({ userId: agentAdmins.userId })
      .from(agentAdmins)
      .where(
        and(
          eq(agentAdmins.workspaceId, workspaceId),
          eq(agentAdmins.agentId, agentId),
          eq(agentAdmins.userId, userId),
        ),
      ),
  );
  facts.directAdmin = direct !== undefined;
  const targets = (
    await tx
      .select({ teamId: agentUsageTargets.teamId })
      .from(agentUsageTargets)
      .where(eq(agentUsageTargets.agentId, agentId))
  ).flatMap((row) => (row.teamId === null ? [] : [row.teamId]));
  const lent = (
    await tx
      .select({ teamId: agentAdminTeams.teamId })
      .from(agentAdminTeams)
      .where(
        and(
          eq(agentAdminTeams.workspaceId, workspaceId),
          eq(agentAdminTeams.agentId, agentId),
        ),
      )
  ).map((row) => row.teamId);
  const teamIds = [
    ...new Set([...targets, ...lent, agent.managingTeamId]),
  ].sort();
  const live = new Set(
    (
      await run(
        tx
          .select({ id: memberTeams.id })
          .from(memberTeams)
          .where(
            and(
              eq(memberTeams.workspaceId, workspaceId),
              inArray(memberTeams.id, teamIds),
              isNull(memberTeams.archivedAt),
            ),
          )
          .orderBy(asc(memberTeams.id)),
      )
    ).map((row) => row.id),
  );
  if (lock && lent.some((id) => live.has(id))) {
    await tx
      .select({ teamId: agentAdminTeams.teamId })
      .from(agentAdminTeams)
      .where(
        and(
          eq(agentAdminTeams.agentId, agentId),
          inArray(
            agentAdminTeams.teamId,
            lent.filter((id) => live.has(id)),
          ),
        ),
      )
      .orderBy(asc(agentAdminTeams.teamId))
      .for("share");
  }
  const roleIn = new Map<string, string>();
  if (live.size > 0) {
    const mine = await run(
      tx
        .select({
          teamId: memberTeamMembers.teamId,
          role: memberTeamMembers.role,
        })
        .from(memberTeamMembers)
        .where(
          and(
            inArray(memberTeamMembers.teamId, [...live]),
            eq(memberTeamMembers.userId, userId),
            isNull(memberTeamMembers.removedAt),
          ),
        )
        .orderBy(asc(memberTeamMembers.teamId), asc(memberTeamMembers.id)),
    );
    for (const row of mine) roleIn.set(row.teamId, row.role);
  }
  const inLive = (ids: readonly string[]) =>
    ids.filter((id) => live.has(id) && roleIn.has(id));
  facts.usageTeams = inLive(targets);
  facts.adminTeams = inLive(lent);
  const managing = agent.managingTeamId;
  if (live.has(managing) && roleIn.has(managing)) {
    facts.managingMember = managing;
    if (roleIn.get(managing) === "lead") facts.managingLead = managing;
  }
  return decideUsage(facts);
}

// One statement, so the scope and revision belong to the teams beside them.
async function readState(
  tx: Reader,
  agentId: string,
): Promise<AgentUsageState | null> {
  const rows = await tx
    .select({
      scope: agentUsage.scope,
      revision: agentUsage.revision,
      teamId: memberTeams.id,
      teamName: memberTeams.name,
    })
    .from(agentUsage)
    .leftJoin(
      agentUsageTargets,
      eq(agentUsageTargets.agentId, agentUsage.agentId),
    )
    .leftJoin(memberTeams, eq(memberTeams.id, agentUsageTargets.teamId))
    .where(eq(agentUsage.agentId, agentId))
    .orderBy(asc(memberTeams.name), asc(memberTeams.id));
  const first = rows[0];
  if (!first) return null;
  return {
    scope: first.scope as AgentUsageScope,
    teams: rows.flatMap((row) =>
      row.teamId !== null && row.teamName !== null
        ? [{ id: row.teamId, name: row.teamName }]
        : [],
    ),
    revision: first.revision,
  };
}

/**
 * The tail of an edit's lock order, shared by every edit that needs the
 * agent's `agent.usage.manage` right (usage, caller limits): admin rows, then
 * every team the decision reads in one id-ordered statement, then the relation
 * rows, then the actor's member rows. The caller holds the agent and
 * agent_usage rows already. A manager's right needs no team; only the teams
 * being `added` are read. Null when the actor no longer manages the agent.
 */
export async function lockEditRight(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    actorUserId: string;
    manager: boolean;
    added: readonly string[];
  },
): Promise<{
  liveTeams: Set<string>;
  roleIn: Map<string, string>;
} | null> {
  const { workspaceId, agentId, manager, added } = input;
  let directAdmin = false;
  let adminTeams: string[] = [];
  let managingTeam: string | null = null;
  if (!manager) {
    const [direct] = await tx
      .select({ userId: agentAdmins.userId })
      .from(agentAdmins)
      .where(
        and(
          eq(agentAdmins.workspaceId, workspaceId),
          eq(agentAdmins.agentId, agentId),
          eq(agentAdmins.userId, input.actorUserId),
        ),
      )
      .for("share");
    directAdmin = direct !== undefined;
    // The agent row is held, so no admin team is added or dropped meanwhile.
    adminTeams = (
      await tx
        .select({ teamId: agentAdminTeams.teamId })
        .from(agentAdminTeams)
        .where(
          and(
            eq(agentAdminTeams.workspaceId, workspaceId),
            eq(agentAdminTeams.agentId, agentId),
          ),
        )
    ).map((row) => row.teamId);
    const [row] = await tx
      .select({ teamId: agents.managingTeamId })
      .from(agents)
      .where(eq(agents.id, agentId));
    managingTeam = row?.teamId ?? null;
  }
  const readTeams = [
    ...new Set([
      ...added,
      ...adminTeams,
      ...(managingTeam ? [managingTeam] : []),
    ]),
  ].sort();
  const liveTeams = new Set<string>();
  const roleIn = new Map<string, string>();
  if (readTeams.length > 0) {
    const teams = await tx
      .select({ id: memberTeams.id, archivedAt: memberTeams.archivedAt })
      .from(memberTeams)
      .where(
        and(
          eq(memberTeams.workspaceId, workspaceId),
          inArray(memberTeams.id, readTeams),
        ),
      )
      .orderBy(asc(memberTeams.id))
      .for("share");
    for (const team of teams) {
      if (team.archivedAt === null) liveTeams.add(team.id);
    }
    if (!manager) {
      if (adminTeams.length > 0) {
        await tx
          .select({ teamId: agentAdminTeams.teamId })
          .from(agentAdminTeams)
          .where(eq(agentAdminTeams.agentId, agentId))
          .orderBy(asc(agentAdminTeams.teamId))
          .for("share");
      }
      const mine = await tx
        .select({
          teamId: memberTeamMembers.teamId,
          role: memberTeamMembers.role,
        })
        .from(memberTeamMembers)
        .where(
          and(
            inArray(memberTeamMembers.teamId, readTeams),
            eq(memberTeamMembers.userId, input.actorUserId),
            isNull(memberTeamMembers.removedAt),
          ),
        )
        .orderBy(asc(memberTeamMembers.teamId))
        .for("share");
      for (const row of mine) roleIn.set(row.teamId, row.role);
    }
  }

  if (!manager) {
    const administers =
      directAdmin ||
      adminTeams.some((id) => liveTeams.has(id) && roleIn.has(id)) ||
      (managingTeam !== null &&
        liveTeams.has(managingTeam) &&
        roleIn.get(managingTeam) === "lead");
    if (!administers) return null;
  }
  return { liveTeams, roleIn };
}

async function put(
  db: Database,
  input: Parameters<AgentUsageStore["put"]>[0],
): Promise<PutAgentUsageResult> {
  const { actor } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  const agentId = input.agentId.toLowerCase();
  const workspaceId = actor.workspaceId;
  if (!input.teamIds.every((id) => UUID.test(id))) {
    return { outcome: "team_not_found" };
  }
  const wanted = [
    ...new Set(input.teamIds.map((id) => id.toLowerCase())),
  ].sort();
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, workspaceId, [actor.userId]);
    const me = people.find((p) => p.userId === actor.userId);
    if (!me?.live) return { outcome: "actor_inactive" };
    const manager = (input.managerRoles as readonly string[]).includes(me.role);

    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
      .for("no key update");
    if (!agent) return { outcome: manager ? "not_found" : "actor_inactive" };

    // Every agent has its row; one inserted by hand without it gets it here.
    await tx
      .insert(agentUsage)
      .values({ agentId, workspaceId })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.agentId, agentId))
      .for("update");
    if (!usage) throw new Error(`agent_usage ${agentId} vanished under a lock`);

    // Whoever writes this agent's targets holds its agent_usage row (this
    // edit, a team's archive), so the list cannot move under the reads below
    // and its own rows need no lock of their own.
    const listed = await tx
      .select({ teamId: agentUsageTargets.teamId })
      .from(agentUsageTargets)
      .where(eq(agentUsageTargets.agentId, agentId));
    const current = listed.flatMap((row) => (row.teamId ? [row.teamId] : []));
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));

    const right = await lockEditRight(tx, {
      workspaceId,
      agentId,
      actorUserId: actor.userId,
      manager,
      added,
    });
    if (!right) return { outcome: "actor_inactive" };
    const { liveTeams, roleIn } = right;
    if (usage.revision !== input.ifMatch) {
      return { outcome: "version_mismatch", current: usage.revision };
    }
    if (added.some((id) => !liveTeams.has(id))) {
      return { outcome: "team_not_found" };
    }
    if (!manager && added.some((id) => !roleIn.has(id))) {
      return { outcome: "team_not_allowed" };
    }

    const stored = await readState(tx, agentId);
    if (!stored) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    if (
      stored.scope === input.scope &&
      added.length === 0 &&
      removed.length === 0
    ) {
      return { outcome: "unchanged", usage: stored };
    }

    if (removed.length > 0) {
      await tx
        .delete(agentUsageTargets)
        .where(
          and(
            eq(agentUsageTargets.agentId, agentId),
            inArray(agentUsageTargets.teamId, removed),
          ),
        );
    }
    if (added.length > 0) {
      await tx.insert(agentUsageTargets).values(
        added.map((teamId) => ({
          agentId,
          workspaceId,
          teamId,
          createdBy: actor.userId,
        })),
      );
    }
    await tx
      .update(agentUsage)
      .set({
        scope: input.scope,
        revision: sql`${agentUsage.revision} + 1`,
        updatedBy: actor.userId,
        updatedAt: DB_NOW,
      })
      .where(eq(agentUsage.agentId, agentId));
    const next = await readState(tx, agentId);
    if (!next) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "set_agent_usage",
      targetRef: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
      result: {
        from: { scope: stored.scope, team_ids: stored.teams.map((t) => t.id) },
        to: { scope: next.scope, team_ids: next.teams.map((t) => t.id) },
        revision: next.revision,
      },
      status: "succeeded",
      requestId: actor.principal.requestId ?? null,
    });
    return { outcome: "set", usage: next };
  });
}

export function createPostgresAgentUsageStore(db: Database): AgentUsageStore {
  return {
    async get(workspaceId, agentId) {
      if (!UUID.test(workspaceId) || !UUID.test(agentId)) return null;
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      if (!agent) return null;
      // An agent without a row reads as the default it would be given.
      return (
        (await readState(db, id)) ?? {
          scope: "workspace",
          teams: [],
          revision: 1,
        }
      );
    },
    put: (input) => put(db, input),
  };
}
