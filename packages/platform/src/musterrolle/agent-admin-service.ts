import {
  type AgentAdminChangeResponse,
  type AgentAdminKind,
  type AgentAdminsView,
  type ListAdministeredAgentsResponse,
  type SetAgentManagingTeamResponse,
  TEAM_LIST_LIMIT,
} from "@werft-ai/contracts";
import type {
  AgentAdminStore,
  AgentAdmins,
} from "../ports/agent-admin-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import {
  NOT_FOUND,
  TEAM_HOLDING,
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "./service-errors.ts";

const NO_LONGER_ADMIN = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds agent.admin.manage",
    undefined,
    { reason_code: "role" },
  );

// Who administers an agent (design 4.1): people and teams, named by an owner,
// an admin or one of the agent's admins (`agent.admin.manage`).

function adminsView(admins: AgentAdmins): AgentAdminsView {
  return {
    users: admins.users.map((user) => ({
      user_id: user.userId,
      email: user.email,
      display_name: user.displayName,
      created_by: user.createdBy,
      created_at: user.createdAt.toISOString(),
    })),
    teams: admins.teams.map((team) => ({
      team_id: team.teamId,
      name: team.name,
      created_by: team.createdBy,
      created_at: team.createdAt.toISOString(),
    })),
  };
}

function personOf(caller: Caller): { userId: string; workspaceId: string } {
  const userId = caller.actor?.userId;
  const workspaceId = caller.actor?.workspaceId;
  if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
    throw new SessionServiceError(
      "FORBIDDEN",
      "Only a signed-in person administers an agent",
      undefined,
      { reason_code: "role" },
    );
  }
  return { userId, workspaceId };
}

export function createAgentAdminService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentAdminStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const managerRoles = MANAGEMENT_ROLES["agent.admin.manage"] ?? [];
  const teamManagerRoles = MANAGEMENT_ROLES["team.manage"] ?? [];

  const onAgent = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.admin.manage", {
      kind: "agent",
      id: agentId,
    });

  async function change(
    caller: Caller,
    agentId: string,
    kind: AgentAdminKind,
    subjectId: string,
    add: boolean,
  ): Promise<AgentAdminChangeResponse> {
    await onAgent(caller, agentId);
    // An admin team makes every member of it an admin, so lending one needs
    // the people who manage teams, not just this agent's admin. Removing a
    // team, and either direction for people, stays with agent.admin.manage.
    const lendsTeam = add && kind === "teams";
    if (lendsTeam) {
      await requirePermitted(authorization, caller, "team.manage", {
        kind: "workspace",
        id: caller.ownerId,
      });
    }
    const { userId, workspaceId } = personOf(caller);
    const receiptId = newId();
    const input = {
      actor: { principal: caller, workspaceId, userId },
      receiptId,
      agentId,
      subject: { kind: kind === "users" ? "user" : "team", id: subjectId },
      // The store re-reads the actor's role in its transaction against these.
      managerRoles: lendsTeam ? teamManagerRoles : managerRoles,
    } as const;
    const result = add ? await store.add(input) : await store.remove(input);
    switch (result.outcome) {
      case "not_found":
        throw NOT_FOUND();
      case "subject_not_found":
        throw new SessionServiceError(
          "NOT_FOUND",
          kind === "users"
            ? "No active member of this workspace has that user id"
            : "No team in this workspace has that id",
        );
      case "actor_inactive":
        throw NO_LONGER_ADMIN();
      case "team_not_allowed":
        throw TEAM_NOT_ALLOWED();
      case "unchanged":
        return { admins: adminsView(result.admins), receipt_id: null };
      default:
        return { admins: adminsView(result.admins), receipt_id: receiptId };
    }
  }

  return {
    async listAgentAdmins(
      caller: Caller,
      agentId: string,
    ): Promise<AgentAdminsView> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const admins = await store.list(caller.ownerId, agentId);
      if (!admins) throw NOT_FOUND();
      return adminsView(admins);
    },

    /**
     * Replaces the agent's managing team. Owners and admins name any live
     * team; anyone else who administers the agent only a team they are in.
     */
    async setManagingTeam(
      caller: Caller,
      agentId: string,
      teamId: string,
    ): Promise<SetAgentManagingTeamResponse> {
      await onAgent(caller, agentId);
      const { userId, workspaceId } = personOf(caller);
      const receiptId = newId();
      const result = await store.setManagingTeam({
        actor: { principal: caller, workspaceId, userId },
        receiptId,
        agentId,
        teamId,
        managerRoles,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "team_not_found":
          throw TEAM_NOT_FOUND();
        case "team_not_allowed":
          throw TEAM_NOT_ALLOWED();
        case "team_holding":
          throw TEAM_HOLDING();
        case "actor_inactive":
          throw NO_LONGER_ADMIN();
        case "unchanged":
          return { agent: result.agent, receipt_id: null };
        default:
          return { agent: result.agent, receipt_id: receiptId };
      }
    },

    addAgentAdmin: (
      caller: Caller,
      agentId: string,
      kind: AgentAdminKind,
      subjectId: string,
    ) => change(caller, agentId, kind, subjectId, true),
    removeAgentAdmin: (
      caller: Caller,
      agentId: string,
      kind: AgentAdminKind,
      subjectId: string,
    ) => change(caller, agentId, kind, subjectId, false),

    /**
     * What the caller administers now. Each row is the store's own
     * administers judgement, read at this request, so it lists nothing a
     * decision on that agent would refuse.
     */
    async listAdministeredAgents(
      caller: Caller,
    ): Promise<ListAdministeredAgentsResponse> {
      const { userId, workspaceId } = personOf(caller);
      return {
        items: await store.listAdministered(
          workspaceId,
          userId,
          TEAM_LIST_LIMIT,
        ),
      };
    },
  };
}

export type AgentAdminService = ReturnType<typeof createAgentAdminService>;
