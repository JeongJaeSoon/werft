import { z } from "zod";

import { receiptIdSchema } from "../shared/index.ts";
import { teamIdSchema, teamNameSchema } from "./teams.ts";

// Who may use an agent (94S-900). `workspace` is every member of the
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

export type AgentUsageScope = z.infer<typeof agentUsageScopeSchema>;
export type PutAgentUsageRequest = z.infer<typeof putAgentUsageRequestSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type PutAgentUsageResponse = z.infer<typeof putAgentUsageResponseSchema>;
