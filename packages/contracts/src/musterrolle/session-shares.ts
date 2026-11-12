import { z } from "zod";

import {
  admissionStateSchema,
  sessionDetailSchema,
  sessionStatusSchema,
} from "../api/session.ts";
import { listTurnsResponseSchema } from "../api/turn.ts";
import {
  agentReleaseIdSchema,
  opaqueCursorSchema,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  receiptIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { apiKeyIdSchema } from "./api-keys.ts";
import { teamIdSchema } from "./teams.ts";

// Who sees a session: its creator alone, the people or teams it
// names, or the whole workspace. Slack DMs start private; channel, web and
// API sessions start workspace-wide.
export const SESSION_SHARE_SCOPE_VALUES = [
  "private",
  "people",
  "team",
  "workspace",
] as const;
export const sessionShareScopeSchema = z.enum(SESSION_SHARE_SCOPE_VALUES);

export const SESSION_SHARE_TARGET_LIMIT = 100;

export const sessionShareSchema = z
  .object({
    session_id: sessionIdSchema,
    scope: sessionShareScopeSchema,
    user_ids: z.array(userIdSchema),
    team_ids: z.array(teamIdSchema),
    /** 0 while the scope was never changed from the workspace default. */
    revision: revisionSchema,
    updated_by: userIdSchema.nullable(),
    updated_at: timestampSchema.nullable(),
    audience_limited: z.boolean().meta({
      description:
        "True when `workspace` reaches only those inside the session's agent, whatever `scope` is now: the workspace's `agent_outsider_session_visibility` is `managing_team` and the agent's managing team is not the holding team that took agents which had none (those stay visible to every member until moved to a real team). Owners, admins, the agent's admins and its managing team's members are inside. `people` and `team` still reach whom they name.",
    }),
  })
  .strict();

export const setSessionShareRequestSchema = z
  .object({
    scope: sessionShareScopeSchema,
    user_ids: z.array(userIdSchema).max(SESSION_SHARE_TARGET_LIMIT).optional(),
    team_ids: z.array(teamIdSchema).max(SESSION_SHARE_TARGET_LIMIT).optional(),
    expected_revision: revisionSchema.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Targets belong to the scope that names them, and that scope names one.
    for (const [key, scope] of [
      ["user_ids", "people"],
      ["team_ids", "team"],
    ] as const) {
      const count = body[key]?.length ?? 0;
      if (body.scope === scope ? count === 0 : count > 0) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            body.scope === scope
              ? `scope ${scope} names at least one target`
              : `only scope ${scope} takes ${key}`,
        });
      }
    }
  });

export const setSessionShareResponseSchema = z
  .object({
    share: sessionShareSchema,
    /** Null when the share was already as asked. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const justificationSchema = z.string().trim().min(1).max(1000);

/**
 * An owner or admin reading a session outside its share. The
 * reason is kept with the decision; the read changes nothing.
 */
export const auditReadRequestSchema = z
  .object({
    justification: justificationSchema,
    cursor: opaqueCursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PAGE_LIMIT_MAX)
      .default(PAGE_LIMIT_DEFAULT),
  })
  .strict();

export const auditReadResponseSchema = z
  .object({
    session: sessionDetailSchema,
    turns: listTurnsResponseSchema,
  })
  .strict();

export const ADMIN_SESSION_LIST_LIMIT = 200;

/** What a manager sees of every session: who, what and when, no content. */
export const adminSessionSchema = z
  .object({
    session_id: sessionIdSchema,
    created_by_user_id: userIdSchema.nullable(),
    created_by_api_key_id: apiKeyIdSchema.nullable(),
    agent_release_id: agentReleaseIdSchema.nullable(),
    status: sessionStatusSchema,
    admission_state: admissionStateSchema,
    share_scope: sessionShareScopeSchema,
    created_at: timestampSchema,
    takeover_required_at: timestampSchema.nullable(),
  })
  .strict();

export const listAdminSessionsResponseSchema = z
  .object({ items: z.array(adminSessionSchema).max(ADMIN_SESSION_LIST_LIMIT) })
  .strict();

export const adminTerminateSessionRequestSchema = z
  .object({
    expected_revision: revisionSchema,
    justification: justificationSchema,
  })
  .strict();

export type SessionShareScope = z.infer<typeof sessionShareScopeSchema>;
export type SessionShareView = z.infer<typeof sessionShareSchema>;
export type SetSessionShareRequest = z.infer<
  typeof setSessionShareRequestSchema
>;
export type SetSessionShareResponse = z.infer<
  typeof setSessionShareResponseSchema
>;
export type AuditReadResponse = z.infer<typeof auditReadResponseSchema>;
export type AdminSession = z.infer<typeof adminSessionSchema>;
export type ListAdminSessionsResponse = z.infer<
  typeof listAdminSessionsResponseSchema
>;
