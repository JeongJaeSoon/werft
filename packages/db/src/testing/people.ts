// Test fixtures only: workspace members, member teams, and the cast of the
// agent caller-limit and usage tests, written through the stores.
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  callerFor,
  type TeamActor,
} from "@werft-ai/platform";
import { createPostgresTeamStore } from "../musterrolle/member-teams.ts";
import type { Database } from "../queries.ts";
import { memberships, users, workspaces } from "../schema.ts";

/** A new user holding `role` in the workspace, as a web caller. */
export async function person(
  db: Database,
  workspaceId: string,
  role: WorkspaceRole,
): Promise<Caller> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: role,
  });
  await db.insert(memberships).values({ workspaceId, userId, role });
  return callerFor(
    {
      kind: "user",
      id: userId,
      workspace_id: workspaceId,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    randomUUID(),
  );
}

export const idOf = (caller: Caller) => caller.actor?.userId ?? "";

export const acting = (caller: Caller): TeamActor => ({
  principal: caller,
  workspaceId: caller.ownerId,
  userId: idOf(caller),
});

export async function newTeam(db: Database, by: Caller): Promise<string> {
  const result = await createPostgresTeamStore(db).create({
    actor: acting(by),
    receiptId: randomUUID(),
    teamId: randomUUID(),
    name: `team-${randomUUID()}`,
  });
  if (result.outcome !== "created") throw new Error(result.outcome);
  return result.team.id;
}

export async function joinTeam(
  db: Database,
  by: Caller,
  teamId: string,
  who: Caller,
  role?: "lead",
): Promise<void> {
  const teams = createPostgresTeamStore(db);
  const write = { actor: acting(by), teamId, userId: idOf(who) };
  await teams.addMember({ ...write, receiptId: randomUUID() });
  if (role) {
    const set = await teams.setMemberRole({
      ...write,
      receiptId: randomUUID(),
      role,
    });
    if (set.outcome !== "changed") throw new Error(set.outcome);
  }
}

/**
 * An owner, the managing team's lead (so an admin of the agent), a plain
 * member of that team, and a second team the lead is not in.
 */
export async function cast(
  db: Database,
  agents: AgentService,
  card: Parameters<AgentService["createAgent"]>[1]["card"],
) {
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `ws-${workspaceId.slice(0, 8)}`,
    name: "ws",
  });
  const owner = await person(db, workspaceId, "owner");
  const lead = await person(db, workspaceId, "member");
  const member = await person(db, workspaceId, "member");
  const managing = await newTeam(db, owner);
  const other = await newTeam(db, owner);
  await joinTeam(db, owner, managing, lead, "lead");
  await joinTeam(db, owner, managing, member);
  const created = await agents.createAgent(owner, {
    slug: `agent-${randomUUID().slice(0, 8)}`,
    name: "재무 분석가",
    card,
    managing_team_id: managing,
  });
  return {
    workspaceId,
    owner,
    lead,
    member,
    managing,
    other,
    agentId: created.agent.id,
  };
}
