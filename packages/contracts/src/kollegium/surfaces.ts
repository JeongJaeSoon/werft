import { z } from "zod";

import {
  agentIdSchema,
  agentReleaseIdSchema,
  installationIdSchema,
  OPAQUE_ID_MAX_LENGTH,
  opaqueIdSchema,
  ownerScopeSchema,
  revisionSchema,
  sessionIdSchema,
  sessionLinkIdSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

/** Where a conversation happens (03 §5). `api` is a direct client. */
export const SURFACE_KIND_VALUES = ["web", "slack", "api"] as const;
export const surfaceKindSchema = z.enum(SURFACE_KIND_VALUES);

/** The link Slack gave for a message; a browser opens it, so https only. */
export const slackPermalinkSchema = z.url({
  protocol: /^https$/,
  hostname: z.regexes.domain,
});

/**
 * The Slack message an input came from. Only where it is, never its text:
 * the permalink opens it for whoever may read it in Slack.
 */
export const slackMessageRefSchema = z.object({
  team_id: z.string().min(1),
  channel_id: z.string().min(1),
  ts: z.string().min(1),
  /** The thread's root when the message is a reply. */
  thread_ts: z.string().min(1).nullable(),
  /** Null when Slack did not answer `chat.getPermalink`. */
  permalink: slackPermalinkSchema.nullable(),
});
export type SlackMessageRef = z.infer<typeof slackMessageRefSchema>;

/** The kind of place inside a chat surface; drives memory visibility. */
export const SURFACE_CHANNEL_KIND_VALUES = [
  "public_channel",
  "private_channel",
  "dm",
] as const;
export const surfaceChannelKindSchema = z.enum(SURFACE_CHANNEL_KIND_VALUES);

/**
 * Admission, not output: `off` stops accepting input, mute only silences.
 * Whether an `on` channel waits for a mention is the agent's one setting.
 */
export const BINDING_MODE_VALUES = ["off", "on"] as const;
export const bindingModeSchema = z.enum(BINDING_MODE_VALUES);

export const MEMORY_WRITE_POLICY_VALUES = ["deny", "allow_explicit"] as const;
export const memoryWritePolicySchema = z.enum(MEMORY_WRITE_POLICY_VALUES);

/**
 * `pending_approval`: a private channel nobody with `binding.approve` has
 * let the agent use yet. Input reads only `ready`, so it takes nothing.
 * `left`: a private channel the bot was removed from or left. Inactive: no
 * input is taken and nothing is sent there. The mode and ceiling are kept,
 * the approval is not; the bot coming back makes it `pending_approval`.
 */
export const SURFACE_BINDING_STATUS_VALUES = [
  "ready",
  "pending_approval",
  "left",
  "partial",
  "failed",
  "revoked",
] as const;
export const surfaceBindingStatusSchema = z.enum(SURFACE_BINDING_STATUS_VALUES);

/**
 * Whether the agent's bot is in a bound channel, as last seen from Slack.
 * `awaiting_invite`: a private channel the bot cannot join itself.
 * `config_error`: Slack refused the token or scope, so membership is
 * unknown, not missing. `join_failed`: joining a public channel was
 * refused (archived, policy). `error` is Slack's error code.
 */
export const SURFACE_MEMBERSHIP_STATE_VALUES = [
  "joined",
  "awaiting_invite",
  "config_error",
  "join_failed",
] as const;
export const surfaceMembershipSchema = z
  .object({
    state: z.enum(SURFACE_MEMBERSHIP_STATE_VALUES),
    error: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .nullable(),
  })
  .strict();

/**
 * What a Slack installation can ever do: read, ask, steer and approve.
 * Recovery, sharing, audit reads, the admin list and deletion are web
 * actions, so no channel setting can hand them to Slack.
 */
export const SLACK_SURFACE_ACTION_VALUES = [
  "session.read",
  "session.submit",
  "session.control",
  "session.approve",
] as const;
export const slackSurfaceActionSchema = z.enum(SLACK_SURFACE_ACTION_VALUES);

/** `summary`: reads in this channel get a summary and a web link (D13). */
export const SURFACE_DISCLOSURE_VALUES = ["full", "summary"] as const;
export const surfaceDisclosureSchema = z.enum(SURFACE_DISCLOSURE_VALUES);

/**
 * A channel's ceiling: the actions its binding allows — approvals only when
 * `session.approve` is listed — and how much of a session it may show.
 */
export const surfaceCeilingSchema = z
  .object({
    actions: z.array(slackSurfaceActionSchema),
    disclosure: surfaceDisclosureSchema,
  })
  .strict();

/**
 * A binding stored without a ceiling of its own: every Slack action, shown
 * in full. The person's role still bounds what they may do (d40).
 */
export const DEFAULT_SURFACE_CEILING = {
  actions: [...SLACK_SURFACE_ACTION_VALUES],
  disclosure: "full",
} as const satisfies z.infer<typeof surfaceCeilingSchema>;

/** A place where one agent works: (installation, external surface) → agent. */
export const surfaceBindingSchema = z
  .object({
    id: surfaceBindingIdSchema,
    workspace_id: workspaceIdSchema,
    /** The server-issued service owner, never the chat team id (03b §5). */
    owner_id: ownerScopeSchema,
    surface: surfaceKindSchema,
    installation_id: installationIdSchema.nullable(),
    /**
     * Channel id as the surface spells it; opaque here. Null on a DM
     * binding: one row covers every DM with the installation's bot.
     */
    external_surface_id: opaqueIdSchema.nullable(),
    surface_kind: surfaceChannelKindSchema.nullable(),
    agent_id: agentIdSchema,
    mode: bindingModeSchema,
    ceiling: surfaceCeilingSchema,
    /** The agent's home channel; an agent has one at most, never a DM. */
    home: z.boolean(),
    memory_write_policy: memoryWritePolicySchema,
    status: surfaceBindingStatusSchema,
    /**
     * When an owner or admin last approved the channel; null for a binding
     * never held for approval. Input sent before it is not answered.
     */
    approved_at: timestampSchema.nullable().optional(),
    /** Absent on a DM binding and on a channel not checked yet. */
    membership: surfaceMembershipSchema.optional(),
    muted: z.boolean(),
    revision: revisionSchema,
    created_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    // One consumer reads `status`, another reads `revoked_at`; if they can
    // disagree, one of them keeps routing events into a revoked binding.
    if ((binding.status === "revoked") !== (binding.revoked_at !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["revoked_at"],
        message: "revoked status and revoked_at must agree",
      });
    }
    // The three columns are nullable because `partial` and `failed` are real
    // states: an install can land before the channel is chosen. `ready` is the
    // claim that routing works, so it cannot be missing what routing needs.
    if (binding.surface_kind === "dm" && binding.external_surface_id !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["external_surface_id"],
        message: "a dm binding covers every dm and names no channel",
      });
    }
    if (binding.home && binding.surface_kind === "dm") {
      ctx.addIssue({
        code: "custom",
        path: ["home"],
        message: "a dm binding is never home",
      });
    }
    if (
      binding.status === "pending_approval" &&
      binding.surface_kind !== "private_channel"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["surface_kind"],
        message: "only a private channel waits for approval",
      });
    }
    if (binding.status === "left") {
      if (binding.surface_kind !== "private_channel") {
        ctx.addIssue({
          code: "custom",
          path: ["surface_kind"],
          message: "only a private channel is left by the bot",
        });
      }
      if (binding.home) {
        ctx.addIssue({
          code: "custom",
          path: ["home"],
          message: "a channel the bot left is never home",
        });
      }
      if (binding.approved_at != null) {
        ctx.addIssue({
          code: "custom",
          path: ["approved_at"],
          message: "a channel the bot left holds no approval",
        });
      }
    }
    if (
      binding.surface !== "slack" ||
      (binding.status !== "ready" &&
        binding.status !== "pending_approval" &&
        binding.status !== "left")
    ) {
      return;
    }
    for (const field of [
      "installation_id",
      "external_surface_id",
      "surface_kind",
    ] as const) {
      if (field === "external_surface_id" && binding.surface_kind === "dm") {
        continue;
      }
      if (binding[field] === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a ready slack binding needs ${field}`,
        });
      }
    }
  });

export const SESSION_LINK_ROLE_VALUES = ["primary", "mirror"] as const;
export const sessionLinkRoleSchema = z.enum(SESSION_LINK_ROLE_VALUES);

/** How much history a newly linked surface may see; the owner chooses (A04). */
export const SESSION_LINK_VISIBILITY_VALUES = ["full", "summary"] as const;
export const sessionLinkVisibilitySchema = z.enum(
  SESSION_LINK_VISIBILITY_VALUES,
);

/**
 * `(installation_id, surface_ref)` is the natural key and stays reserved after
 * revocation: a new message on a revoked thread needs an explicit rebind, it
 * does not quietly open a new session.
 */
// The cap has to admit every pair the component schemas accept, or a valid
// conversation has no representable ref at all — so it is derived, not picked.
// `encodeURIComponent` turns one UTF-16 code unit into at most 9 characters
// (`%EA%B0%80` for a Hangul syllable); a surrogate pair is 2 units and 12
// characters, so 9 per unit is the ceiling. Two components plus the separator.
const MAX_PERCENT_ENCODED_EXPANSION = 9;
export const SURFACE_REF_MAX_LENGTH =
  OPAQUE_ID_MAX_LENGTH * MAX_PERCENT_ENCODED_EXPANSION * 2 + 1;
export const surfaceRefSchema = z.string().min(1).max(SURFACE_REF_MAX_LENGTH);

/** The spelling itself, with no validation — what a refinement can compare to. */
function canonicalSurfaceRef(channelId: string, threadId: string): string {
  return `${encodeURIComponent(channelId)}:${encodeURIComponent(threadId)}`;
}

/**
 * Both components are opaque strings a surface mints, and a surface is free to
 * put a colon in one: plain concatenation makes `("a:b", "c")` and
 * `("a", "b:c")` the same ref, which is two conversations sharing one reserved
 * link key and messages resolving to the wrong session. Percent-encode each
 * component so the separator only ever appears where this function put it.
 */
export function formatSurfaceRef(channelId: string, threadId: string): string {
  if (channelId.length === 0 || threadId.length === 0) {
    throw new TypeError("surface ref: empty component");
  }
  return surfaceRefSchema.parse(canonicalSurfaceRef(channelId, threadId));
}

export const sessionLinkSchema = z
  .object({
    id: sessionLinkIdSchema,
    workspace_id: workspaceIdSchema,
    owner_id: ownerScopeSchema,
    session_id: sessionIdSchema,
    surface: surfaceKindSchema,
    installation_id: installationIdSchema,
    surface_binding_id: surfaceBindingIdSchema,
    surface_ref: surfaceRefSchema,
    channel_id: opaqueIdSchema.nullable(),
    thread_id: opaqueIdSchema.nullable(),
    agent_id: agentIdSchema,
    release_id: agentReleaseIdSchema.nullable(),
    role: sessionLinkRoleSchema,
    visibility: sessionLinkVisibilitySchema,
    muted: z.boolean(),
    revision: revisionSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((link, ctx) => {
    // `(installation_id, surface_ref)` is a reserved natural key, so one
    // conversation must have exactly one spelling. A writer that concatenated
    // the ids itself would otherwise reserve a second key for the same thread
    // and open a second session on it. Half an identity is worse than none: it
    // skips canonicalisation and lets any spelling through.
    if ((link.channel_id === null) !== (link.thread_id === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["thread_id"],
        message: "channel_id and thread_id are both set or both null",
      });
    } else if (link.channel_id !== null && link.thread_id !== null) {
      // `canonicalSurfaceRef`, not the formatter: a `parse` here would throw
      // out of `safeParse` instead of reporting an issue.
      const canonical = canonicalSurfaceRef(link.channel_id, link.thread_id);
      if (link.surface_ref !== canonical) {
        ctx.addIssue({
          code: "custom",
          path: ["surface_ref"],
          message: "must be formatSurfaceRef(channel_id, thread_id)",
        });
      }
    }
    // `ScopedSessionBinding` — what every inbound message resolves to — needs
    // the release pin. A live link missing it would be admitted here and then
    // fail every bind, so it is not a state worth storing. Only a revoked link
    // may have lost it.
    if (link.revoked_at !== null) return;
    if (link.release_id === null) {
      ctx.addIssue({
        code: "custom",
        path: ["release_id"],
        message: "a live session link needs release_id",
      });
    }
  });

export type SurfaceKind = z.infer<typeof surfaceKindSchema>;
export type SurfaceChannelKind = z.infer<typeof surfaceChannelKindSchema>;
export type BindingMode = z.infer<typeof bindingModeSchema>;
export type MemoryWritePolicy = z.infer<typeof memoryWritePolicySchema>;
export type SurfaceBindingStatus = z.infer<typeof surfaceBindingStatusSchema>;
export type SurfaceMembership = z.infer<typeof surfaceMembershipSchema>;
export type SurfaceMembershipState = SurfaceMembership["state"];
export type SlackSurfaceAction = z.infer<typeof slackSurfaceActionSchema>;
export type SurfaceDisclosure = z.infer<typeof surfaceDisclosureSchema>;
export type SurfaceCeiling = z.infer<typeof surfaceCeilingSchema>;
export type SurfaceBinding = z.infer<typeof surfaceBindingSchema>;
export type SessionLinkRole = z.infer<typeof sessionLinkRoleSchema>;
export type SessionLinkVisibility = z.infer<typeof sessionLinkVisibilitySchema>;
export type SessionLink = z.infer<typeof sessionLinkSchema>;
