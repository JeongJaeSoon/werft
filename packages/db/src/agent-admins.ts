import type { TeamMemberRole } from "@werft-ai/contracts";
import type {
  AgentAdminChangeResult,
  AgentAdminStore,
  AgentAdmins,
  SetManagingTeamResult,
  TeamActor,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { administers, liveMember } from "./administers.ts";
import { agentOf, managingTeamName } from "./agents.ts";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `administers`, inside a write: the rows that make it true are share-locked
 * so removing them waits for this transaction, or is seen by it.
 *
 * The agent row first, FOR NO KEY UPDATE, as admin and managing-team changes
 * take it before their rows: those changes queue behind this write instead
 * of crossing it, and a caller that then updates the agent already holds it.
 * Callers lock the acting person (lockedRole, lockPeople) before calling.
 */
export async function lockedAdministers(
  tx: Database,
  workspaceId: string,
  agentId: string,
  userId: string,
): Promise<boolean> {
  const [agent] = await tx
    .select({ managingTeamId: agents.managingTeamId })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
    .for("no key update");
  if (!agent) return false;
  const direct = await tx
    .select({ agentId: agentAdmins.agentId })
    .from(agentAdmins)
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
        eq(agentAdmins.userId, userId),
      ),
    )
    .limit(1)
    .for("share");
  if (direct.length > 0) return true;
  const viaTeam = () =>
    tx
      .select({ teamId: agentAdminTeams.teamId })
      .from(agentAdminTeams)
      .innerJoin(
        memberTeams,
        and(
          eq(memberTeams.id, agentAdminTeams.teamId),
          isNull(memberTeams.archivedAt),
        ),
      )
      .innerJoin(
        memberTeamMembers,
        and(
          eq(memberTeamMembers.teamId, agentAdminTeams.teamId),
          isNull(memberTeamMembers.removedAt),
        ),
      )
      .where(
        and(
          eq(agentAdminTeams.workspaceId, workspaceId),
          eq(agentAdminTeams.agentId, agentId),
          eq(memberTeamMembers.userId, userId),
        ),
      );
  // Team rows first, in a statement of their own: a team's writers lock it
  // before its other rows, and one statement locks its rows in no set order
  // whatever FOR SHARE OF lists.
  const teams = await viaTeam().for("share", { of: memberTeams });
  if (teams.length > 0) {
    const held = await viaTeam()
      .limit(1)
      .for("share", { of: [memberTeams, agentAdminTeams, memberTeamMembers] });
    if (held.length > 0) return true;
  }
  return lockedTeamRow(tx, workspaceId, agent.managingTeamId, userId, ["lead"]);
}

/**
 * Whether `userId` is in the live team `teamId` with one of `roles`, both
 * rows share-locked: an archive, a removal or a role change waits for this
 * write or is seen by it. Team before member row, as team writers lock them.
 */
export async function lockedTeamRow(
  tx: Database,
  workspaceId: string,
  teamId: string,
  userId: string,
  roles: readonly TeamMemberRole[],
): Promise<boolean> {
  const [team] = await tx
    .select({ id: memberTeams.id })
    .from(memberTeams)
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        eq(memberTeams.id, teamId),
        isNull(memberTeams.archivedAt),
      ),
    )
    .for("share");
  if (!team) return false;
  const row = await tx
    .select({ id: memberTeamMembers.id })
    .from(memberTeamMembers)
    .where(
      and(
        eq(memberTeamMembers.teamId, team.id),
        eq(memberTeamMembers.userId, userId),
        isNull(memberTeamMembers.removedAt),
        inArray(memberTeamMembers.role, [...roles]),
      ),
    )
    .limit(1)
    .for("share");
  return row.length > 0;
}

/**
 * Whether `teamId` may become an agent's managing team for this actor: any
 * live team of the workspace for an owner or admin, else only one the actor
 * is in (agent-rbac design (d)). Locks what it read, as `lockedTeamRow`.
 * The holding team of migration 0243 is never a destination, for anyone: its
 * agents keep their old session visibility, which another agent must not get
 * by being moved there. `keep` is the agent's current team, which may stay.
 */
export async function managingTeamAllowed(
  tx: Database,
  workspaceId: string,
  teamId: string,
  actor: { userId: string; manager: boolean },
  keep?: string,
): Promise<"ok" | "team_not_found" | "team_not_allowed" | "team_holding"> {
  if (!UUID.test(teamId)) return "team_not_found";
  const id = teamId.toLowerCase();
  const [held] = await tx
    .select({ holds: memberTeams.holdsUnassigned })
    .from(memberTeams)
    .where(
      and(eq(memberTeams.workspaceId, workspaceId), eq(memberTeams.id, id)),
    )
    .for("share");
  if (held?.holds && id !== keep) return "team_holding";
  if (!actor.manager) {
    return (await lockedTeamRow(tx, workspaceId, id, actor.userId, [
      "lead",
      "member",
    ]))
      ? "ok"
      : "team_not_allowed";
  }
  const [team] = await tx
    .select({ id: memberTeams.id })
    .from(memberTeams)
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        eq(memberTeams.id, id),
        isNull(memberTeams.archivedAt),
      ),
    )
    .for("share");
  return team ? "ok" : "team_not_found";
}

async function setManagingTeam(
  db: Database,
  input: Parameters<AgentAdminStore["setManagingTeam"]>[0],
): Promise<SetManagingTeamResult> {
  const { actor } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  const agentId = input.agentId.toLowerCase();
  const workspaceId = actor.workspaceId;
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, workspaceId, [actor.userId]);
    const may = await actorMayManage(
      tx,
      actor,
      people,
      agentId,
      input.managerRoles,
    );
    if (may === "no") return { outcome: "actor_inactive" };
    if (may === "no_agent") return { outcome: "not_found" };
    const manager = (input.managerRoles as readonly string[]).includes(
      people[0]?.role ?? "",
    );
    const [before] = await tx
      .select({ teamId: agents.managingTeamId })
      .from(agents)
      .where(eq(agents.id, agentId));
    const allowed = await managingTeamAllowed(
      tx,
      workspaceId,
      input.teamId,
      { userId: actor.userId, manager },
      before?.teamId,
    );
    if (allowed !== "ok") return { outcome: allowed };
    const teamId = input.teamId.toLowerCase();
    if (before?.teamId === teamId) {
      return { outcome: "unchanged", agent: await agentRow(tx, agentId) };
    }
    await tx
      .update(agents)
      .set({ managingTeamId: teamId, updatedAt: DB_NOW })
      .where(eq(agents.id, agentId));
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "set_agent_managing_team",
      targetRef: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
      result: { from: before?.teamId ?? null, to: teamId },
      status: "succeeded",
      requestId: actor.principal.requestId ?? null,
    });
    return { outcome: "set", agent: await agentRow(tx, agentId) };
  });
}

async function agentRow(tx: Database, agentId: string) {
  const [row] = await tx
    .select({ agent: agents, teamName: managingTeamName })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) throw new Error(`agent ${agentId} vanished under its lock`);
  return agentOf(row.agent, row.teamName);
}

async function listAdmins(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<AgentAdmins> {
  const people = await db
    .select({
      userId: agentAdmins.userId,
      email: users.email,
      displayName: users.displayName,
      createdBy: agentAdmins.createdBy,
      createdAt: agentAdmins.createdAt,
    })
    .from(agentAdmins)
    .innerJoin(users, eq(users.id, agentAdmins.userId))
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        eq(agentAdmins.agentId, agentId),
      ),
    )
    .orderBy(asc(agentAdmins.createdAt), asc(agentAdmins.userId));
  const teams = await db
    .select({
      teamId: agentAdminTeams.teamId,
      name: memberTeams.name,
      createdBy: agentAdminTeams.createdBy,
      createdAt: agentAdminTeams.createdAt,
    })
    .from(agentAdminTeams)
    .innerJoin(memberTeams, eq(memberTeams.id, agentAdminTeams.teamId))
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        eq(agentAdminTeams.agentId, agentId),
      ),
    )
    .orderBy(asc(agentAdminTeams.createdAt), asc(agentAdminTeams.teamId));
  return { users: people, teams };
}

// The acting person may change this agent's admins: a live member whose role
// holds the right, or who administers the agent themselves. `people` are
// locked first by lockPeople; the agent row, locked before the admin rows,
// queues changes to one agent's admins so two admins removing each other
// cannot each hold the row the other deletes.
async function actorMayManage(
  tx: Database,
  actor: TeamActor,
  people: Awaited<ReturnType<typeof lockPeople>>,
  agentId: string,
  managerRoles: readonly string[],
): Promise<"yes" | "no" | "no_agent"> {
  const me = people.find((p) => p.userId === actor.userId);
  if (!me?.live) return "no";
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.workspaceId, actor.workspaceId), eq(agents.id, agentId)),
    )
    .for("no key update");
  if (!agent) return managerRoles.includes(me.role) ? "no_agent" : "no";
  if (managerRoles.includes(me.role)) return "yes";
  return (await lockedAdministers(tx, actor.workspaceId, agentId, actor.userId))
    ? "yes"
    : "no";
}

async function change(
  db: Database,
  input: Parameters<AgentAdminStore["add"]>[0],
  add: boolean,
): Promise<AgentAdminChangeResult> {
  const { actor, subject } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  if (!UUID.test(subject.id)) return { outcome: "subject_not_found" };
  const agentId = input.agentId.toLowerCase();
  const subjectId = subject.id.toLowerCase();
  const workspaceId = actor.workspaceId;
  return db.transaction(async (tx) => {
    const people = await lockPeople(
      tx,
      workspaceId,
      subject.kind === "user" ? [actor.userId, subjectId] : [actor.userId],
    );
    const may = await actorMayManage(
      tx,
      actor,
      people,
      agentId,
      input.managerRoles,
    );
    if (may === "no") return { outcome: "actor_inactive" };
    if (may === "no_agent") return { outcome: "not_found" };

    let changed: boolean;
    if (subject.kind === "user") {
      if (add) {
        const live = people.some((p) => p.userId === subjectId && p.live);
        if (!live) return { outcome: "subject_not_found" };
        const inserted = await tx
          .insert(agentAdmins)
          .values({
            workspaceId,
            agentId,
            userId: subjectId,
            createdBy: actor.userId,
          })
          .onConflictDoNothing()
          .returning({ userId: agentAdmins.userId });
        changed = inserted.length > 0;
      } else {
        const deleted = await tx
          .delete(agentAdmins)
          .where(
            and(
              eq(agentAdmins.workspaceId, workspaceId),
              eq(agentAdmins.agentId, agentId),
              eq(agentAdmins.userId, subjectId),
            ),
          )
          .returning({ userId: agentAdmins.userId });
        changed = deleted.length > 0;
      }
    } else if (add) {
      const [team] = await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, workspaceId),
            eq(memberTeams.id, subjectId),
            isNull(memberTeams.archivedAt),
          ),
        )
        .for("share");
      if (!team) return { outcome: "subject_not_found" };
      // An admin team makes all its members admins, so anyone but an owner
      // or admin may lend only a team they lead. Rows already there stay.
      const manager = (input.managerRoles as readonly string[]).includes(
        people.find((p) => p.userId === actor.userId)?.role ?? "",
      );
      if (
        !manager &&
        !(await lockedTeamRow(tx, actor.workspaceId, subjectId, actor.userId, [
          "lead",
        ]))
      ) {
        return { outcome: "team_not_allowed" };
      }
      const inserted = await tx
        .insert(agentAdminTeams)
        .values({
          workspaceId,
          agentId,
          teamId: subjectId,
          createdBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning({ teamId: agentAdminTeams.teamId });
      changed = inserted.length > 0;
    } else {
      const deleted = await tx
        .delete(agentAdminTeams)
        .where(
          and(
            eq(agentAdminTeams.workspaceId, workspaceId),
            eq(agentAdminTeams.agentId, agentId),
            eq(agentAdminTeams.teamId, subjectId),
          ),
        )
        .returning({ teamId: agentAdminTeams.teamId });
      changed = deleted.length > 0;
    }

    if (changed) {
      await tx.insert(receipts).values({
        id: input.receiptId,
        ownerId: actor.principal.ownerId,
        actor: receiptActorOf(actor.principal),
        operation: add ? "add_agent_admin" : "remove_agent_admin",
        targetRef: {
          resource: { kind: "agent", id: agentId },
          workspace_id: workspaceId,
        },
        result: { subject: { kind: subject.kind, id: subjectId } },
        status: "succeeded",
        requestId: actor.principal.requestId ?? null,
      });
    }
    return {
      outcome: changed ? (add ? "added" : "removed") : "unchanged",
      admins: await listAdmins(tx, workspaceId, agentId),
    };
  });
}

export function createPostgresAgentAdminStore(db: Database): AgentAdminStore {
  return {
    async list(workspaceId, agentId) {
      if (!UUID.test(workspaceId) || !UUID.test(agentId)) return null;
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      if (!agent) return null;
      return listAdmins(db, workspaceId, id);
    },
    add: (input) => change(db, input, true),
    remove: (input) => change(db, input, false),
    setManagingTeam: (input) => setManagingTeam(db, input),
    async listAdministered(workspaceId, userId, limit) {
      if (!UUID.test(workspaceId) || !UUID.test(userId)) return [];
      const rows = await db
        .select({ agent: agents, teamName: managingTeamName })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            administers(db, workspaceId, userId.toLowerCase(), agents.id),
            liveMember(db, workspaceId, userId.toLowerCase()),
          ),
        )
        .orderBy(asc(agents.createdAt), asc(agents.id))
        .limit(limit);
      return rows.map((row) => agentOf(row.agent, row.teamName));
    },
  };
}
