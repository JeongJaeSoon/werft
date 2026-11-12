import { z } from "zod";

import {
  agentDescriptionSchema,
  agentSlugSchema,
} from "../kollegium/agents.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  receiptIdSchema,
} from "../shared/index.ts";
import { TEAM_LIST_LIMIT, teamIdSchema, teamNameSchema } from "./teams.ts";

// Who may use an agent. `workspace` is every member of the
// workspace; `private` is the members of the listed teams. Owners, admins and
// the agent's admins edit it (`agent.usage.manage`); this contract carries the
// data and the edit, and decides nothing about a session.

export const AGENT_USAGE_SCOPE_VALUES = ["workspace", "private"] as const;
export const agentUsageScopeSchema = z.enum(AGENT_USAGE_SCOPE_VALUES);

/** The most teams one agent lists. */
export const AGENT_USAGE_TEAM_MAX = 50;

/**
 * The whole setting is replaced. `private` names at least one team and
 * `workspace` none; a person is not a target here, only a team.
 */
export const putAgentUsageRequestSchema = z
  .object({
    scope: agentUsageScopeSchema,
    teams: z
      .array(z.object({ id: teamIdSchema }).strict())
      .max(AGENT_USAGE_TEAM_MAX),
  })
  .strict()
  .superRefine((request, ctx) => {
    const ids = request.teams.map((team) => team.id.toLowerCase());
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["teams"],
        message: "teams must not repeat a team",
      });
    }
    if (request.scope === "private" && ids.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["teams"],
        message: "a private agent names at least one team",
      });
    }
    if (request.scope === "workspace" && ids.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["teams"],
        message: "a workspace agent names no team",
      });
    }
  });

export const agentUsageSchema = z
  .object({
    scope: agentUsageScopeSchema,
    teams: z.array(
      z.object({ id: teamIdSchema, name: teamNameSchema }).strict(),
    ),
    /** The `If-Match` value of the next edit. */
    revision: z.number().int().positive(),
  })
  .strict();

export const putAgentUsageResponseSchema = z
  .object({
    usage: agentUsageSchema,
    /** Null when the agent already had that setting. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/**
 * One agent the caller could start a session with right now. Only
 * what a new-session screen picks from; the managing team's name is public to
 * whoever may use the agent, and no admin or creator is named.
 */
export const usableAgentSchema = z
  .object({
    id: agentIdSchema,
    slug: agentSlugSchema,
    name: z.string().min(1).max(120),
    description: agentDescriptionSchema.nullable(),
    managing_team_name: z.string().min(1),
    /** The release a session on this agent pins when it names none. */
    active_release_id: agentReleaseIdSchema,
  })
  .strict();

export const listUsableAgentsResponseSchema = z
  .object({ items: z.array(usableAgentSchema).max(TEAM_LIST_LIMIT) })
  .strict();

export type UsableAgent = z.infer<typeof usableAgentSchema>;
export type ListUsableAgentsResponse = z.infer<
  typeof listUsableAgentsResponseSchema
>;
export type AgentUsageScope = z.infer<typeof agentUsageScopeSchema>;
export type PutAgentUsageRequest = z.infer<typeof putAgentUsageRequestSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type PutAgentUsageResponse = z.infer<typeof putAgentUsageResponseSchema>;
