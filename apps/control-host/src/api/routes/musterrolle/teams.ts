import {
  addAgentAdminRequestSchema,
  addTeamMemberRequestSchema,
  agentAdminChangeResponseSchema,
  agentAdminParamsSchema,
  agentAdminsViewSchema,
  agentIdParamsSchema,
  createTeamRequestSchema,
  deleteTeamResponseSchema,
  listAdministeredAgentsResponseSchema,
  listMyTeamsQuerySchema,
  listMyTeamsResponseSchema,
  listTeamsQuerySchema,
  listTeamsResponseSchema,
  setAgentManagingTeamRequestSchema,
  setAgentManagingTeamResponseSchema,
  setTeamMemberRoleRequestSchema,
  teamChangeResponseSchema,
  teamDetailSchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  updateTeamRequestSchema,
} from "@werft-ai/contracts";
import type { AgentAdminService, TeamService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { mapped, requireParams, requireQuery } from "../errors.ts";

export function registerTeamRoutes(
  router: ApiRouter,
  teams: TeamService,
  agentAdmins: AgentAdminService,
) {
  apiRoute(router, "createTeam", async (context) => {
    const body = await parseJsonBody(context, createTeamRequestSchema);
    const created = await mapped(() =>
      teams.createTeam(context.get("caller"), body),
    );
    return jsonWithSchema(context, teamChangeResponseSchema, created, 201);
  });

  apiRoute(router, "listTeams", async (context) => {
    const query = requireQuery(context, listTeamsQuerySchema);
    const listed = await mapped(() =>
      teams.listTeams(context.get("caller"), query),
    );
    return jsonWithSchema(context, listTeamsResponseSchema, listed);
  });

  apiRoute(router, "listMyTeams", async (context) => {
    const query = requireQuery(context, listMyTeamsQuerySchema);
    const listed = await mapped(() =>
      teams.listMyTeams(context.get("caller"), query),
    );
    return jsonWithSchema(context, listMyTeamsResponseSchema, listed);
  });

  apiRoute(router, "getTeam", async (context) => {
    const params = requireParams(context, teamIdParamsSchema);
    const team = await mapped(() =>
      teams.getTeam(context.get("caller"), params.team_id),
    );
    return jsonWithSchema(context, teamDetailSchema, team);
  });

  apiRoute(router, "updateTeam", async (context) => {
    const params = requireParams(context, teamIdParamsSchema);
    const body = await parseJsonBody(context, updateTeamRequestSchema);
    const changed = await mapped(() =>
      teams.renameTeam(context.get("caller"), params.team_id, body),
    );
    return jsonWithSchema(context, teamChangeResponseSchema, changed);
  });

  apiRoute(router, "deleteTeam", async (context) => {
    const params = requireParams(context, teamIdParamsSchema);
    const deleted = await mapped(() =>
      teams.deleteTeam(context.get("caller"), params.team_id),
    );
    return jsonWithSchema(context, deleteTeamResponseSchema, deleted);
  });

  apiRoute(router, "addTeamMember", async (context) => {
    const params = requireParams(context, teamIdParamsSchema);
    const body = await parseJsonBody(context, addTeamMemberRequestSchema);
    const changed = await mapped(() =>
      teams.addTeamMember(context.get("caller"), params.team_id, body.user_id),
    );
    return jsonWithSchema(context, teamChangeResponseSchema, changed);
  });

  apiRoute(router, "removeTeamMember", async (context) => {
    const params = requireParams(context, teamMemberParamsSchema);
    const changed = await mapped(() =>
      teams.removeTeamMember(
        context.get("caller"),
        params.team_id,
        params.user_id,
      ),
    );
    return jsonWithSchema(context, teamChangeResponseSchema, changed);
  });

  apiRoute(router, "setTeamMemberRole", async (context) => {
    const params = requireParams(context, teamMemberParamsSchema);
    const body = await parseJsonBody(context, setTeamMemberRoleRequestSchema);
    const changed = await mapped(() =>
      teams.setTeamMemberRole(
        context.get("caller"),
        params.team_id,
        params.user_id,
        body,
      ),
    );
    return jsonWithSchema(context, teamChangeResponseSchema, changed);
  });

  apiRoute(router, "setAgentManagingTeam", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setAgentManagingTeamRequestSchema,
    );
    const changed = await mapped(() =>
      agentAdmins.setManagingTeam(
        context.get("caller"),
        params.id,
        body.team_id,
      ),
    );
    return jsonWithSchema(context, setAgentManagingTeamResponseSchema, changed);
  });

  apiRoute(router, "listAgentAdmins", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const admins = await mapped(() =>
      agentAdmins.listAgentAdmins(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, agentAdminsViewSchema, admins);
  });

  apiRoute(router, "addAgentAdmin", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, addAgentAdminRequestSchema);
    const [kind, subjectId] =
      body.user_id !== undefined
        ? (["users", body.user_id] as const)
        : (["teams", body.team_id ?? ""] as const);
    const changed = await mapped(() =>
      agentAdmins.addAgentAdmin(
        context.get("caller"),
        params.id,
        kind,
        subjectId,
      ),
    );
    return jsonWithSchema(context, agentAdminChangeResponseSchema, changed);
  });

  apiRoute(router, "removeAgentAdmin", async (context) => {
    const params = requireParams(context, agentAdminParamsSchema);
    const changed = await mapped(() =>
      agentAdmins.removeAgentAdmin(
        context.get("caller"),
        params.id,
        params.kind,
        params.subject_id,
      ),
    );
    return jsonWithSchema(context, agentAdminChangeResponseSchema, changed);
  });

  apiRoute(router, "listAdministeredAgents", async (context) => {
    const listed = await mapped(() =>
      agentAdmins.listAdministeredAgents(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      listAdministeredAgentsResponseSchema,
      listed,
    );
  });
}
