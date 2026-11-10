import type { AgentUsageScope } from "@werft-ai/contracts";
import type {
  AgentUsageState,
  AgentUsageStore,
  PutAgentUsageResult,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockedAdministers } from "./agent-admins.ts";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agents,
  agentUsage,
  agentUsageTargets,
  memberTeamMembers,
  memberTeams,
  receipts,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The edit takes rows in the order the notes' P1.6c gives (see also the list
// in requester-locks.ts): user → membership → agent → agent_usage → admin rows
// → the teams being added (id order) → agent_usage_targets → their member
// rows. A team's archive takes agent_usage before the team, so the two meet
// in that order and one waits for the other.

type Reader = Pick<Database, "select">;

async function readState(
  tx: Reader,
  agentId: string,
): Promise<AgentUsageState | null> {
  const [row] = await tx
    .select({ scope: agentUsage.scope, revision: agentUsage.revision })
    .from(agentUsage)
    .where(eq(agentUsage.agentId, agentId));
  if (!row) return null;
  const teams = await tx
    .select({ id: memberTeams.id, name: memberTeams.name })
    .from(agentUsageTargets)
    .innerJoin(memberTeams, eq(memberTeams.id, agentUsageTargets.teamId))
    .where(eq(agentUsageTargets.agentId, agentId))
    .orderBy(asc(memberTeams.name), asc(memberTeams.id));
  return {
    scope: row.scope as AgentUsageScope,
    teams,
    revision: row.revision,
  };
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

    if (!manager) {
      const administers = await lockedAdministers(
        tx,
        workspaceId,
        agentId,
        actor.userId,
      );
      if (!administers) return { outcome: "actor_inactive" };
    }
    if (usage.revision !== input.ifMatch) {
      return { outcome: "version_mismatch", current: usage.revision };
    }

    const before = await tx
      .select({ teamId: agentUsageTargets.teamId })
      .from(agentUsageTargets)
      .where(eq(agentUsageTargets.agentId, agentId))
      .orderBy(asc(agentUsageTargets.teamId))
      .for("update");
    const current = before.flatMap((row) => (row.teamId ? [row.teamId] : []));
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));

    if (added.length > 0) {
      const live = await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            inArray(memberTeams.id, added),
            isNull(memberTeams.archivedAt),
          ),
        )
        .orderBy(asc(memberTeams.id))
        .for("share");
      if (live.length !== added.length) return { outcome: "team_not_found" };
      if (!manager) {
        const mine = await tx
          .select({ teamId: memberTeamMembers.teamId })
          .from(memberTeamMembers)
          .where(
            and(
              inArray(memberTeamMembers.teamId, added),
              eq(memberTeamMembers.userId, actor.userId),
              isNull(memberTeamMembers.removedAt),
            ),
          )
          .orderBy(asc(memberTeamMembers.teamId))
          .for("share");
        if (new Set(mine.map((row) => row.teamId)).size !== added.length) {
          return { outcome: "team_not_allowed" };
        }
      }
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
