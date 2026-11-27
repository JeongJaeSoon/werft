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

export const WORKSPACE_NAME_MAX = 120;
export const workspaceNameSchema = z.string().min(1).max(WORKSPACE_NAME_MAX);
export const workspaceNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_NAME_MAX);
export const workspaceSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const emailSchema = z.email().max(254);
export const DISPLAY_NAME_MAX = 64;
/** What a stored name reads as; a name written before the trim rule stays readable. */
export const displayNameSchema = z.string().min(1).max(DISPLAY_NAME_MAX);
/** A name a client sends: the ends trimmed, whitespace alone refused. */
export const displayNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(DISPLAY_NAME_MAX);
/**
 * A name derived from a provider's claim or an email address: trimmed and
 * cut to `DISPLAY_NAME_MAX` without splitting a surrogate pair. Empty when
 * nothing but whitespace was given.
 */
export function clampDisplayName(name: string): string {
  const cut = name.trim().slice(0, DISPLAY_NAME_MAX);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd();
}

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

export const ACHIEVEMENT_TRANSCRIPT_VALUES = ["none", "recent"] as const;

const achievementJudgeFields = {
  /** An `openai_decisions` connection; null leaves `luna` rules unjudged. */
  connection_id: z.string().min(1).max(200).nullable().default(null),
  threshold: z.number().min(0).max(1).default(0.9),
  on_evidence: z.boolean().default(true),
  every_n_turns: z.number().int().min(5).max(100).nullable().default(null),
  on_idle: z.boolean().default(false),
  transcript: z.enum(ACHIEVEMENT_TRANSCRIPT_VALUES).default("recent"),
  daily_budget_usd: z.number().nonnegative().default(1),
  max_per_session: z.number().int().positive().default(20),
};

/** How the workspace's achievement judge runs. What a write accepts. */
export const achievementJudgeSettingsSchema = z
  .object(achievementJudgeFields)
  .strict();

/**
 * The same fields, for reading what is stored: a key this build does not know
 * (a newer build wrote it) is left out of the result, not refused. A known key
 * with a bad value is still refused.
 */
const storedAchievementJudgeSettingsSchema = z.object(achievementJudgeFields);

const workspaceSettingsFields = (
  judge:
    | typeof achievementJudgeSettingsSchema
    | typeof storedAchievementJudgeSettingsSchema,
) => ({
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
  /**
   * Whether the engine asks Anthropic (api.anthropic.com) about a host
   * before WebFetch dials it. Off, sessions skip that check; the egress
   * allowlist still decides what a session may reach.
   */
  web_fetch_preflight: z.boolean().default(true),
  achievement_judge: judge.prefault({}),
});

/** What a write accepts: an unknown key is refused. */
export const workspaceSettingsSchema = z
  .object(workspaceSettingsFields(achievementJudgeSettingsSchema))
  .strict();

/**
 * What a read of `workspaces.settings` accepts. Every build adds keys to that
 * jsonb, and an older replica or a rolled-back install meets rows a newer
 * build wrote, so a key unknown here is left out of the result (the stored row
 * keeps it) instead of failing GET /v1/auth/me. Reading stays lenient first,
 * writing strict later, as for migrations.
 */
export const storedWorkspaceSettingsSchema = z.object(
  workspaceSettingsFields(storedAchievementJudgeSettingsSchema),
);

export const workspaceParamsSchema = z
  .object({ id: workspaceIdSchema })
  .strict();

export const auditRetentionRequestSchema = z
  .object({ audit_retention_days: auditRetentionDaysSchema })
  .strict();
export const auditRetentionResponseSchema = auditRetentionRequestSchema;

export const achievementJudgeRequestSchema = achievementJudgeSettingsSchema;
export const achievementJudgeResponseSchema = z
  .object({
    achievement_judge: achievementJudgeSettingsSchema,
    /** The enabled `openai_decisions` connections `connection_id` may name. */
    connections: z.array(z.string().min(1)),
  })
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

export const webFetchPreflightRequestSchema = z
  .object({ web_fetch_preflight: z.boolean() })
  .strict();
export const webFetchPreflightResponseSchema = z
  .object({ web_fetch_preflight: z.boolean(), receipt_id: receiptIdSchema })
  .strict();

export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
    name: workspaceNameSchema,
    settings: workspaceSettingsSchema,
    created_at: timestampSchema,
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
 * `details.reason_code` of the 409 ALREADY_EXISTS that POST /v1/invites
 * answers when the address belongs to a member whose membership is on.
 */
export const INVITE_ALREADY_MEMBER = "already_member";

/**
 * The only place an invite token ever appears. It is returned once, to the
 * inviter, and never read back from storage.
 */
export const createInviteResponseSchema = z
  .object({
    invite_id: inviteIdSchema,
    invite_token: z.string().min(32).max(256),
    /** The console path that accepts the invite; it carries the token. */
    accept_path: z.string().startsWith("/invite/").max(512),
    /** `accept_path` on CONSOLE_ORIGIN; null when that is unset. */
    accept_url: z.string().url().max(2048).nullable(),
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
export type WebFetchPreflightRequest = z.infer<
  typeof webFetchPreflightRequestSchema
>;
export type WebFetchPreflightResponse = z.infer<
  typeof webFetchPreflightResponseSchema
>;
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
