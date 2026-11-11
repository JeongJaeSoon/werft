import { z } from "zod";

import { PAYLOAD_TOO_LARGE_ISSUE } from "../api/session.ts";
import {
  agentIdSchema,
  inviteIdSchema,
  PAGE_LIMIT_MAX,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { workspaceRoleSchema } from "./authorization.ts";

export { WORKSPACE_ROLE_VALUES, workspaceRoleSchema } from "./authorization.ts";

export const workspaceSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const emailSchema = z.email().max(254);
export const DISPLAY_NAME_MAX = 64;
export const displayNameSchema = z.string().min(1).max(DISPLAY_NAME_MAX);

/** Emails are compared lower-cased; store what this returns. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const AUDIT_RETENTION_DEFAULT_DAYS = 90;
export const AUDIT_RETENTION_MIN_DAYS = 30;
// The upper bound only keeps a typo from meaning forever.
export const AUDIT_RETENTION_MAX_DAYS = 3650;
export const auditRetentionDaysSchema = z
  .number()
  .int()
  .min(AUDIT_RETENTION_MIN_DAYS)
  .max(AUDIT_RETENTION_MAX_DAYS);

/**
 * What a member outside an agent may do with it (agent-rbac (c), axis A):
 * `use` reads and runs it, `view` only reads it, `none` hides it.
 */
export const AGENT_OUTSIDER_ACCESS_VALUES = ["use", "view", "none"] as const;
export const agentOutsiderAccessSchema = z.enum(AGENT_OUTSIDER_ACCESS_VALUES);
/**
 * Who sees a `workspace`-scoped session of an agent (axis B):
 * `managing_team` only those inside the agent, `workspace` every member. An
 * agent still held by the "Unassigned agents" team of migration 0243 is not
 * limited either way until it moves to a real team.
 */
export const AGENT_OUTSIDER_SESSION_VISIBILITY_VALUES = [
  "managing_team",
  "workspace",
] as const;
export const agentOutsiderSessionVisibilitySchema = z.enum(
  AGENT_OUTSIDER_SESSION_VISIBILITY_VALUES,
);

export const ACHIEVEMENT_TRANSCRIPT_VALUES = ["none", "recent"] as const;

/** How the workspace's achievement judge runs (achievement-rules.md §3). */
export const achievementJudgeSettingsSchema = z
  .object({
    /** An `openai_decisions` connection; null leaves `luna` rules unjudged. */
    connection_id: z.string().min(1).max(200).nullable().default(null),
    threshold: z.number().min(0).max(1).default(0.9),
    on_evidence: z.boolean().default(true),
    every_n_turns: z.number().int().min(5).max(100).nullable().default(null),
    on_idle: z.boolean().default(false),
    transcript: z.enum(ACHIEVEMENT_TRANSCRIPT_VALUES).default("recent"),
    daily_budget_usd: z.number().nonnegative().default(1),
    max_per_session: z.number().int().positive().default(20),
  })
  .strict();

export const workspaceSettingsSchema = z
  .object({
    /** Model the dispatch classifier uses; null falls back to the deployment default. */
    dispatch_model: z.string().min(1).max(128).nullable().default(null),
    /** Workspace-wide stop: new dispatches become needs_confirm only. */
    kill_switch: z.boolean().default(false),
    daily_cost_limit_usd: z.number().nonnegative().nullable().default(null),
    /** Minutes of silence before the reconciler pauses a session. */
    idle_pause_minutes: z.number().int().positive().default(30),
    /** How long `authz_decisions` rows are kept before the reconciler deletes them. */
    audit_retention_days: auditRetentionDaysSchema.default(
      AUDIT_RETENTION_DEFAULT_DAYS,
    ),
    /**
     * Whether a Slack guest may call an agent at all. On, a guest still has
     * to link their Slack account like anyone else.
     */
    slack_guest_enabled: z.boolean().default(false),
    agent_outsider_access: agentOutsiderAccessSchema.default("use"),
    agent_outsider_session_visibility:
      agentOutsiderSessionVisibilitySchema.default("managing_team"),
    achievement_judge: achievementJudgeSettingsSchema.prefault({}),
  })
  .strict();

export const workspaceParamsSchema = z
  .object({ id: workspaceIdSchema })
  .strict();

export const auditRetentionRequestSchema = z
  .object({ audit_retention_days: auditRetentionDaysSchema })
  .strict();
export const auditRetentionResponseSchema = auditRetentionRequestSchema;

export const achievementJudgeRequestSchema = achievementJudgeSettingsSchema;
export const achievementJudgeResponseSchema = z
  .object({ achievement_judge: achievementJudgeSettingsSchema })
  .strict();
export const achievementJudgeChangeResponseSchema = z
  .object({
    achievement_judge: achievementJudgeSettingsSchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export const slackGuestRequestSchema = z
  .object({ slack_guest_enabled: z.boolean() })
  .strict();
export const slackGuestResponseSchema = slackGuestRequestSchema;

export const agentAccessSettingsSchema = z
  .object({
    agent_outsider_access: agentOutsiderAccessSchema,
    agent_outsider_session_visibility: agentOutsiderSessionVisibilitySchema,
  })
  .strict();
/** A key left out keeps its value. */
export const agentAccessRequestSchema = agentAccessSettingsSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Name at least one setting",
  });
export const agentAccessResponseSchema = agentAccessSettingsSchema
  .extend({
    /** Null when both settings already were what was asked. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
    name: z.string().min(1).max(120),
    settings: workspaceSettingsSchema,
    created_at: timestampSchema,
  })
  .strict();

export const userSchema = z
  .object({
    id: userIdSchema,
    email: emailSchema,
    display_name: displayNameSchema,
    created_at: timestampSchema,
    /** Account suspension, kept distinct from losing one membership (A03). */
    disabled_at: timestampSchema.nullable(),
  })
  .strict();

export const membershipSchema = z
  .object({
    workspace_id: workspaceIdSchema,
    user_id: userIdSchema,
    role: workspaceRoleSchema,
    created_at: timestampSchema,
    disabled_at: timestampSchema.nullable(),
  })
  .strict();

export const memberViewSchema = z
  .object({
    user_id: userIdSchema,
    email: emailSchema,
    display_name: displayNameSchema,
    role: workspaceRoleSchema,
    disabled_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

/**
 * Why the caller may not do something to a member: the lower-cased error code
 * the write answers with, or `unchanged` when it would answer 200 and change
 * nothing. A list never says `last_owner`: only two owners demoting or
 * disabling each other at once reach it, and the write's row locks decide.
 */
export const MEMBER_REFUSAL_VALUES = [
  "self_protected",
  "owner_protected",
  "last_owner",
  "member_disabled",
  "account_disabled",
  "unchanged",
] as const;
export const memberRefusalSchema = z.enum(MEMBER_REFUSAL_VALUES);

export const memberVerdictSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  z.object({ allowed: z.literal(false), reason: memberRefusalSchema }).strict(),
]);

/** What the caller may do to one member, worked out when the list was read. */
export const memberActionsSchema = z
  .object({
    change_role: z
      .object({
        owner: memberVerdictSchema,
        admin: memberVerdictSchema,
        member: memberVerdictSchema,
      })
      .strict(),
    disable: memberVerdictSchema,
    enable: memberVerdictSchema,
  })
  .strict();

export const ADMINISTERED_VIA_VALUES = ["user", "team"] as const;

export const administeredAgentSchema = z
  .object({
    id: agentIdSchema,
    name: z.string(),
    via: z.enum(ADMINISTERED_VIA_VALUES).meta({
      description:
        "`user` when the member is the agent's admin themselves, `team` when only a team they belong to is. A member who is both is listed once, as `user`.",
    }),
  })
  .strict();

/** A row of the member list: the member and what the caller may do to them. */
export const memberRowSchema = memberViewSchema
  .extend({
    actions: memberActionsSchema,
    administered_agents: z.array(administeredAgentSchema).meta({
      description:
        "The agents the member administers, archived agents left out, by name. A team counts while it is not archived and the member has not left it. A disabled member keeps the grants listed here; they act again once the member is enabled.",
    }),
    last_active_at: timestampSchema.nullable().meta({
      description:
        "When the member last used the web console: a web sign-in, or a web request, recorded at most once an hour. API key calls, Slack and session activity do not count. It stays after the web session expires, is signed out or revoked: only the member's next sign-in removes old sessions, and that sign-in is newer. Null when the member has never signed in to the web console.",
    }),
  })
  .strict();

export const INVITE_STATUS_VALUES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export const inviteStatusSchema = z.enum(INVITE_STATUS_VALUES);

/**
 * The stored invite. It deliberately has no token field: only the hash is
 * persisted, so a leaked row cannot be redeemed.
 */
export const inviteSchema = z
  .object({
    id: inviteIdSchema,
    workspace_id: workspaceIdSchema,
    email: emailSchema,
    role: workspaceRoleSchema,
    invited_by: userIdSchema,
    status: inviteStatusSchema,
    expires_at: timestampSchema,
    accepted_at: timestampSchema.nullable(),
    revoked_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict()
  .superRefine((invite, ctx) => {
    // The status and the audit timestamps answer the same question — is this
    // still redeemable — so they cannot give different answers. `expired` is
    // the one status with no timestamp of its own: `expires_at` already
    // carries it, and a row is expired by the clock rather than by a write.
    const stamped = {
      accepted: invite.accepted_at,
      revoked: invite.revoked_at,
    } as const;
    for (const [status, at] of Object.entries(stamped)) {
      const field = `${status}_at` as const;
      if (invite.status === status && at === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a ${status} invite carries its ${field}`,
        });
      }
      if (invite.status !== status && at !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `only a ${status} invite carries ${field}`,
        });
      }
    }
  });

export const createInviteRequestSchema = z
  .object({ email: emailSchema, role: workspaceRoleSchema })
  .strict();

/**
 * The only place an invite token ever appears. It is returned once, to the
 * inviter, and never read back from storage.
 */
export const createInviteResponseSchema = z
  .object({
    invite_id: inviteIdSchema,
    invite_token: z.string().min(32).max(256),
    expires_at: timestampSchema,
  })
  .strict();

export const INVITE_TTL_DAYS = 7;
export const INVITE_LIST_LIMIT = 200;
export const inviteTokenSchema = createInviteResponseSchema.shape.invite_token;

export const inviteIdParamsSchema = z.object({ id: inviteIdSchema }).strict();
export const memberUserParamsSchema = z
  .object({ user_id: userIdSchema })
  .strict();

// Deactivation is its own route; this patch changes the role only.
export const updateMemberRequestSchema = z
  .object({ role: workspaceRoleSchema })
  .strict();
export const updateMemberResponseSchema = memberViewSchema;

export const ACCESS_REASON_MAX_BYTES = 1024;
const utf8 = new TextEncoder();

/** Disabling or enabling a membership or an account. */
export const setAccessRequestSchema = z
  .object({
    /** Kept on the receipt, for whoever reads the audit later. */
    reason: z
      .string()
      .min(1)
      .refine((text) => utf8.encode(text).length <= ACCESS_REASON_MAX_BYTES, {
        message: `Reason exceeds ${ACCESS_REASON_MAX_BYTES} UTF-8 bytes`,
        params: { code: PAYLOAD_TOO_LARGE_ISSUE },
      })
      .meta({
        description: `At most ${ACCESS_REASON_MAX_BYTES} bytes of UTF-8`,
      })
      .optional(),
  })
  .strict();

export const setAccessResponseSchema = z
  .object({
    member: memberViewSchema,
    /** Null when the state already was what was asked: nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export const MEMBER_SEARCH_MAX_CHARS = 200;
export const MEMBER_USER_IDS_MAX = PAGE_LIMIT_MAX;
export const listMembersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(MEMBER_SEARCH_MAX_CHARS).optional().meta({
    description:
      "Matches a member whose display name or email contains it, ignoring case. `%` and `_` match themselves.",
  }),
  user_ids: z
    .string()
    .min(1)
    .max(MEMBER_USER_IDS_MAX * 37)
    .transform((value) => value.split(","))
    .pipe(z.array(userIdSchema).min(1).max(MEMBER_USER_IDS_MAX))
    .optional()
    .meta({
      description: `Comma-separated user ids, at most ${MEMBER_USER_IDS_MAX}: keeps the members among them, in the list's order. An id of no member is left out.`,
    }),
});
/** Oldest membership first, user id breaking ties. */
export const listMembersResponseSchema = pageSchema(memberRowSchema)
  .extend({
    assignable_roles: z.array(workspaceRoleSchema).meta({
      description:
        "The roles the caller may invite someone as now (POST /v1/invites refuses any other with OWNER_PROTECTED). The same on every page and search.",
    }),
  })
  .strict();
/** Newest first; at most INVITE_LIST_LIMIT. */
export const listInvitesResponseSchema = z
  .object({ items: z.array(inviteSchema).max(INVITE_LIST_LIMIT) })
  .strict();

export type AuditRetentionRequest = z.infer<typeof auditRetentionRequestSchema>;
export type SlackGuestRequest = z.infer<typeof slackGuestRequestSchema>;
export type AgentOutsiderAccess = z.infer<typeof agentOutsiderAccessSchema>;
export type AgentAccessSettings = z.infer<typeof agentAccessSettingsSchema>;
export type AgentAccessResponse = z.infer<typeof agentAccessResponseSchema>;
export type AchievementJudgeSettings = z.infer<
  typeof achievementJudgeSettingsSchema
>;
export type AchievementJudgeResponse = z.infer<
  typeof achievementJudgeResponseSchema
>;
export type AchievementJudgeChangeResponse = z.infer<
  typeof achievementJudgeChangeResponseSchema
>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type MemberView = z.infer<typeof memberViewSchema>;
export type MemberRefusal = z.infer<typeof memberRefusalSchema>;
export type MemberVerdict = z.infer<typeof memberVerdictSchema>;
export type MemberActions = z.infer<typeof memberActionsSchema>;
export type MemberRow = z.infer<typeof memberRowSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;
