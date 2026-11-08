import { z } from "zod";

import { agentSchema } from "../kollegium/agents.ts";
import {
  agentIdSchema,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// Teams (design 4.7): a group of people in a workspace. Naming a team an
// agent's admin makes every member of it one. Only an owner or an admin
// changes a team (`team.manage`, D23), and a person added joins at once.

/** How many agents GET /v1/administered-agents returns at most. */
export const TEAM_LIST_LIMIT = 200;

export const teamIdSchema = z.uuid();

/**
 * A `lead` administers every agent the team manages; a `member` does not.
 * Only owners and admins set it (`team.manage`).
 */
export const TEAM_MEMBER_ROLE_VALUES = ["lead", "member"] as const;
export const teamMemberRoleSchema = z.enum(TEAM_MEMBER_ROLE_VALUES);
export const TEAM_NAME_MAX = 100;
export const teamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX);

export const teamIdParamsSchema = z.object({ team_id: teamIdSchema }).strict();
export const teamMemberParamsSchema = z
  .object({ team_id: teamIdSchema, user_id: userIdSchema })
  .strict();

export const teamViewSchema = z
  .object({
    id: teamIdSchema,
    workspace_id: workspaceIdSchema,
    name: teamNameSchema,
    member_count: z.number().int().nonnegative(),
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    revision: z.number().int().positive(),
  })
  .strict();

export const teamMemberViewSchema = z
  .object({
    user_id: userIdSchema,
    email: z.string(),
    display_name: z.string().nullable(),
    role: teamMemberRoleSchema,
    added_by: userIdSchema.nullable(),
    added_at: timestampSchema,
    /** The person's workspace membership state, as in the members list: null while active. */
    disabled_at: timestampSchema.nullable(),
  })
  .strict();

export const teamDetailSchema = teamViewSchema
  .extend({ members: z.array(teamMemberViewSchema) })
  .strict();

export const createTeamRequestSchema = z
  .object({ name: teamNameSchema })
  .strict();
export const updateTeamRequestSchema = createTeamRequestSchema;
export const addTeamMemberRequestSchema = z
  .object({ user_id: userIdSchema })
  .strict();
export const setTeamMemberRoleRequestSchema = z
  .object({ role: teamMemberRoleSchema })
  .strict();

export const teamChangeResponseSchema = z
  .object({
    team: teamViewSchema,
    /** Null when the team already was what was asked: nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const deleteTeamResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

export const TEAM_SEARCH_MAX_CHARS = 200;
export const listTeamsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(TEAM_SEARCH_MAX_CHARS).optional().meta({
    description:
      "Keeps the teams whose name contains it, ignoring case. `%` and `_` match themselves.",
  }),
});
/** The workspace's teams, by name then id. */
export const listTeamsResponseSchema = pageSchema(teamViewSchema);

// ---------------------------------------------------------------------------
// Agent admins (design 4.1): people and teams
// ---------------------------------------------------------------------------

export const AGENT_ADMIN_KIND_VALUES = ["users", "teams"] as const;
export const agentAdminKindSchema = z.enum(AGENT_ADMIN_KIND_VALUES);

export const agentAdminParamsSchema = z
  .object({
    id: agentIdSchema,
    kind: agentAdminKindSchema,
    subject_id: z.uuid(),
  })
  .strict();

/** A person or a team, never both. */
export const addAgentAdminRequestSchema = z
  .object({
    user_id: userIdSchema.optional(),
    team_id: teamIdSchema.optional(),
  })
  .strict()
  .refine(
    (body) => (body.user_id === undefined) !== (body.team_id === undefined),
    {
      message: "name exactly one of user_id and team_id",
    },
  );

export const agentAdminsViewSchema = z
  .object({
    users: z.array(
      z
        .object({
          user_id: userIdSchema,
          email: z.string(),
          display_name: z.string().nullable(),
          created_by: userIdSchema.nullable(),
          created_at: timestampSchema,
        })
        .strict(),
    ),
    teams: z.array(
      z
        .object({
          team_id: teamIdSchema,
          name: teamNameSchema,
          created_by: userIdSchema.nullable(),
          created_at: timestampSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const agentAdminChangeResponseSchema = z
  .object({
    admins: agentAdminsViewSchema,
    /** Null when the agent's admins already were what was asked. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/** The agents the caller administers now, directly or through a team. */
export const listAdministeredAgentsResponseSchema = z
  .object({ items: z.array(agentSchema).max(TEAM_LIST_LIMIT) })
  .strict();

/**
 * The agent's managing team. Null is refused: an agent from before managing
 * teams is given one, never had one taken.
 */
export const setAgentManagingTeamRequestSchema = z
  .object({ team_id: teamIdSchema })
  .strict();
export const setAgentManagingTeamResponseSchema = z
  .object({
    agent: agentSchema,
    /** Null when the agent already had that team. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/**
 * The teams the caller belongs to now, with the caller's role in each. Names
 * only: who else is in a team is for the people who manage teams (D23).
 */
export const listMyTeamsQuerySchema = paginationQuerySchema;
export const listMyTeamsResponseSchema = pageSchema(
  z
    .object({
      id: teamIdSchema,
      name: teamNameSchema,
      role: teamMemberRoleSchema,
    })
    .strict(),
);

export type TeamView = z.infer<typeof teamViewSchema>;
export type TeamMemberView = z.infer<typeof teamMemberViewSchema>;
export type TeamDetail = z.infer<typeof teamDetailSchema>;
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>;
export type UpdateTeamRequest = z.infer<typeof updateTeamRequestSchema>;
export type AddTeamMemberRequest = z.infer<typeof addTeamMemberRequestSchema>;
export type AddAgentAdminRequest = z.infer<typeof addAgentAdminRequestSchema>;
export type TeamChangeResponse = z.infer<typeof teamChangeResponseSchema>;
export type DeleteTeamResponse = z.infer<typeof deleteTeamResponseSchema>;
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
export type ListTeamsResponse = z.infer<typeof listTeamsResponseSchema>;
export type AgentAdminKind = z.infer<typeof agentAdminKindSchema>;
export type AgentAdminsView = z.infer<typeof agentAdminsViewSchema>;
export type AgentAdminChangeResponse = z.infer<
  typeof agentAdminChangeResponseSchema
>;
export type ListAdministeredAgentsResponse = z.infer<
  typeof listAdministeredAgentsResponseSchema
>;
export type TeamMemberRole = z.infer<typeof teamMemberRoleSchema>;
export type SetTeamMemberRoleRequest = z.infer<
  typeof setTeamMemberRoleRequestSchema
>;
export type SetAgentManagingTeamRequest = z.infer<
  typeof setAgentManagingTeamRequestSchema
>;
export type SetAgentManagingTeamResponse = z.infer<
  typeof setAgentManagingTeamResponseSchema
>;
export type ListMyTeamsQuery = z.infer<typeof listMyTeamsQuerySchema>;
export type ListMyTeamsResponse = z.infer<typeof listMyTeamsResponseSchema>;
