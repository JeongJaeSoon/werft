import type {
  CreateTeamRequest,
  DeleteTeamResponse,
  ListMyTeamsQuery,
  ListMyTeamsResponse,
  ListTeamsQuery,
  ListTeamsResponse,
  SetTeamMemberRoleRequest,
  TeamChangeResponse,
  TeamDetail as TeamDetailView,
  TeamView,
  UpdateTeamRequest,
} from "@werft-ai/contracts";
import type {
  Team,
  TeamActor,
  TeamDetail,
  TeamStore,
} from "../ports/team-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { NOT_FOUND } from "./service-errors.ts";

// Teams (design 4.7). Every route asks the policy for `team.manage` on the
// workspace (owner, admin: D23), and the store re-reads that role under a
// share lock in the transaction that writes.

// The caller's role fell between the decision and the write.
const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds team.manage",
    undefined,
    { reason_code: "role" },
  );
const NAME_TAKEN = () =>
  new SessionServiceError(
    "ALREADY_EXISTS",
    "A team by that name already exists in this workspace",
  );

const MEMBER_DISABLED = () =>
  new SessionServiceError(
    "MEMBER_DISABLED",
    "The member is disabled; reactivate them first",
  );

export function teamView(team: Team): TeamView {
  return {
    id: team.id,
    workspace_id: team.workspaceId,
    name: team.name,
    member_count: team.memberCount,
    created_by: team.createdBy,
    created_at: team.createdAt.toISOString(),
    revision: team.revision,
  };
}

function detailView(team: TeamDetail): TeamDetailView {
  return {
    ...teamView(team),
    members: team.members.map((member) => ({
      user_id: member.userId,
      email: member.email,
      display_name: member.displayName,
      role: member.role,
      added_by: member.addedBy,
      added_at: member.addedAt.toISOString(),
      disabled_at: member.disabledAt?.toISOString() ?? null,
    })),
  };
}

export function createTeamService(deps: {
  authorization: AuthorizationPolicy;
  store: TeamStore;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function manager(caller: Caller): Promise<TeamActor> {
    await requirePermitted(authorization, caller, "team.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    // The policy grants team.manage to people only; this keeps a write from
    // ever lacking the person who made it.
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes a team",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  async function changeMember(
    caller: Caller,
    teamId: string,
    userId: string,
    add: boolean,
  ): Promise<TeamChangeResponse> {
    const actor = await manager(caller);
    const receiptId = newId();
    const input = { actor, receiptId, teamId, userId };
    const result = add
      ? await store.addMember(input)
      : await store.removeMember(input);
    switch (result.outcome) {
      case "not_found":
        throw NOT_FOUND();
      case "not_member":
        throw new SessionServiceError(
          "NOT_FOUND",
          "No active member of this workspace has that user id",
        );
      case "actor_inactive":
        throw OUTRANKED();
      case "member_disabled":
        throw MEMBER_DISABLED();
      case "unchanged":
        return { team: teamView(result.team), receipt_id: null };
      default:
        return { team: teamView(result.team), receipt_id: receiptId };
    }
  }

  return {
    async listTeams(
      caller: Caller,
      query: ListTeamsQuery,
    ): Promise<ListTeamsResponse> {
      await manager(caller);
      const page = await store.list(caller.ownerId, query);
      return { items: page.items.map(teamView), next_cursor: page.nextCursor };
    },

    // Reading one's own membership asks no policy, as with administered agents.
    async listMyTeams(
      caller: Caller,
      query: ListMyTeamsQuery,
    ): Promise<ListMyTeamsResponse> {
      const userId = caller.actor?.userId;
      const workspaceId = caller.actor?.workspaceId;
      if (
        caller.subject.principal?.kind !== "user" ||
        !userId ||
        !workspaceId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "Only a signed-in person belongs to a team",
          undefined,
          { reason_code: "role" },
        );
      }
      const page = await store.listJoined(workspaceId, userId, query);
      return {
        items: page.items.map(({ id, name, role }) => ({ id, name, role })),
        next_cursor: page.nextCursor,
      };
    },

    // A team's own members read it, read only and asking no policy, as with
    // their list of teams (D23 keeps changing it to managers).
    async getTeam(caller: Caller, teamId: string): Promise<TeamDetailView> {
      const userId = caller.actor?.userId;
      const workspaceId = caller.actor?.workspaceId;
      const member =
        caller.subject.principal?.kind === "user" &&
        !!userId &&
        !!workspaceId &&
        (await store.isMember(workspaceId, teamId, userId));
      if (!member) await manager(caller);
      const team = await store.get(caller.ownerId, teamId);
      if (!team) throw NOT_FOUND();
      return detailView(team);
    },

    async createTeam(
      caller: Caller,
      request: CreateTeamRequest,
    ): Promise<TeamChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.create({
        actor,
        receiptId,
        teamId: newId(),
        name: request.name,
      });
      switch (result.outcome) {
        case "name_taken":
          throw NAME_TAKEN();
        case "actor_inactive":
          throw OUTRANKED();
        default:
          return { team: teamView(result.team), receipt_id: receiptId };
      }
    },

    async renameTeam(
      caller: Caller,
      teamId: string,
      request: UpdateTeamRequest,
    ): Promise<TeamChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.rename({
        actor,
        receiptId,
        teamId,
        name: request.name,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "name_taken":
          throw NAME_TAKEN();
        case "actor_inactive":
          throw OUTRANKED();
        case "unchanged":
          return { team: teamView(result.team), receipt_id: null };
        default:
          return { team: teamView(result.team), receipt_id: receiptId };
      }
    },

    async deleteTeam(
      caller: Caller,
      teamId: string,
    ): Promise<DeleteTeamResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.delete({ actor, receiptId, teamId });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw OUTRANKED();
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "Agents changed who may use them while the team was archived; try again",
          );
        case "manages_agents":
          throw new SessionServiceError(
            "TEAM_MANAGES_AGENTS",
            "The team manages agents; give them another managing team first",
            undefined,
            { agent_ids: result.agentIds },
          );
        default:
          return { receipt_id: receiptId };
      }
    },

    async setTeamMemberRole(
      caller: Caller,
      teamId: string,
      userId: string,
      request: SetTeamMemberRoleRequest,
    ): Promise<TeamChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.setMemberRole({
        actor,
        receiptId,
        teamId,
        userId,
        role: request.role,
      });
      switch (result.outcome) {
        case "not_found":
        case "not_member":
          throw NOT_FOUND();
        case "actor_inactive":
          throw OUTRANKED();
        case "member_disabled":
          throw MEMBER_DISABLED();
        case "unchanged":
          return { team: teamView(result.team), receipt_id: null };
        default:
          return { team: teamView(result.team), receipt_id: receiptId };
      }
    },

    addTeamMember: (caller: Caller, teamId: string, userId: string) =>
      changeMember(caller, teamId, userId, true),
    removeTeamMember: (caller: Caller, teamId: string, userId: string) =>
      changeMember(caller, teamId, userId, false),
  };
}

export type TeamService = ReturnType<typeof createTeamService>;
