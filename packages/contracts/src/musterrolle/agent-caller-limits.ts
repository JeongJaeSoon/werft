import { z } from "zod";

import { opaqueIdSchema, receiptIdSchema } from "../shared/index.ts";
import { catalogRepositoryIdSchema } from "./github-repository.ts";
import { teamIdSchema } from "./teams.ts";

// What a caller may do through an agent (94S-917): rules stored per caller
// target, edited by owners, admins and the agent's admins
// (`agent.usage.manage`). This contract carries the data and the edit and
// decides nothing about a session; the consumer reads the rules elsewhere.
//
// Meaning of a rule's lists, for whoever enforces them:
//  - `tools_deny` and `credentials_deny` name what the caller may not use.
//    Names are not checked against anything.
//  - `repositories` and `mcp_servers` name all the caller may use. `null` is no
//    limit, `[]` allows none. A repository id the catalog no longer holds is
//    not an allowance: it may stay in a stored rule, and counts as absent.

export const AGENT_CALLER_LIMIT_RULE_MAX = 100;
export const AGENT_CALLER_LIMIT_NAME_MAX = 200;

/** `user` is stored but the v1 API neither reads nor takes it. */
export const AGENT_CALLER_LIMIT_TARGET_KINDS = [
  "workspace",
  "team",
  "channel",
  "user",
] as const;

export const agentCallerLimitTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("team"), id: teamIdSchema }).strict(),
  z.object({ kind: z.literal("channel"), id: opaqueIdSchema }).strict(),
]);

const nameList = (item: z.ZodString) =>
  z.array(item).max(AGENT_CALLER_LIMIT_NAME_MAX);

const nameSchema = z.string().min(1).max(200);

const distinct = (list: readonly string[] | null) =>
  list === null || new Set(list).size === list.length;

export const agentCallerLimitRuleSchema = z
  .object({
    target: agentCallerLimitTargetSchema,
    tools_deny: nameList(nameSchema),
    repositories: nameList(catalogRepositoryIdSchema).nullable(),
    mcp_servers: nameList(nameSchema).nullable(),
    credentials_deny: nameList(nameSchema),
  })
  .strict()
  .superRefine((rule, ctx) => {
    for (const field of [
      "tools_deny",
      "repositories",
      "mcp_servers",
      "credentials_deny",
    ] as const) {
      if (!distinct(rule[field])) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not repeat a name`,
        });
      }
    }
  });

/** The whole set is replaced. */
export const putAgentCallerLimitsRequestSchema = z
  .object({
    rules: z.array(agentCallerLimitRuleSchema).max(AGENT_CALLER_LIMIT_RULE_MAX),
  })
  .strict()
  .superRefine((request, ctx) => {
    // A channel id is kept as sent (Slack's differ by case); a uuid is lowered.
    const keys = request.rules.map((rule) =>
      rule.target.kind === "workspace"
        ? "workspace"
        : rule.target.kind === "channel"
          ? `channel:${rule.target.id}`
          : `team:${rule.target.id.toLowerCase()}`,
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: "rules must not repeat a target",
      });
    }
  });

export const agentCallerLimitsSchema = z
  .object({
    rules: z.array(agentCallerLimitRuleSchema),
    /** The `If-Match` value of the next edit. */
    revision: z.number().int().positive(),
  })
  .strict();

export const putAgentCallerLimitsResponseSchema = z
  .object({
    limits: agentCallerLimitsSchema,
    /** Null when the agent already had those rules. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type AgentCallerLimitTarget = z.infer<
  typeof agentCallerLimitTargetSchema
>;
export type AgentCallerLimitRule = z.infer<typeof agentCallerLimitRuleSchema>;
export type PutAgentCallerLimitsRequest = z.infer<
  typeof putAgentCallerLimitsRequestSchema
>;
export type AgentCallerLimits = z.infer<typeof agentCallerLimitsSchema>;
export type PutAgentCallerLimitsResponse = z.infer<
  typeof putAgentCallerLimitsResponseSchema
>;
