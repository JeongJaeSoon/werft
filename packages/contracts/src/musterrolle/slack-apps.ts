import { z } from "zod";

import { agentIdSchema, timestampSchema } from "../shared/index.ts";
import { slackIdSchema } from "./agent-identities.ts";
import {
  type SECRET_PURPOSE_VALUES,
  slackSecretSummarySchema,
} from "./slack-secrets.ts";
import { workspaceParamsSchema } from "./workspaces.ts";

/**
 * The bot scopes every agent app is created with and the authorize URL asks
 * for. Adding one grants the agent more authority in Slack, which is why a
 * test pins the list. `channels:join` lets the agent join a public channel
 * the console picks for it; `groups:write` lets it leave a private channel
 * whose invite an admin turned down. `chat:write.customize` shows an
 * instruction sent from the web or the API under its sender's name.
 */
export const BOT_SCOPES = [
  "assistant:write",
  "app_mentions:read",
  "chat:write",
  "chat:write.customize",
  "im:history",
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  "users:read",
  "channels:join",
  "groups:write",
] as const;

/**
 * The bot events Finalize registers once the events route can answer the
 * app's signed challenge; creation registers none. `member_joined_channel`
 * is how an invite to a private channel is noticed. The bot being removed
 * from a channel comes to the bot itself as `channel_left` (public) or
 * `group_left` (private); real Slack sent no `member_left_channel` for it,
 * which is kept for what the mock and older apps send. A channel being
 * archived, renamed or deleted comes as `channel_*` (public) or `group_*`
 * (private), on scopes the app already holds, as does a channel being
 * shared with another organization or no longer (`channel_shared`,
 * `channel_unshared`). An app made before
 * an event was added receives it only after its manifest is sent again
 * (events recheck).
 */
export const SLACK_AGENT_BOT_EVENTS = [
  "app_mention",
  "message.im",
  "message.channels",
  "message.groups",
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_archive",
  "channel_unarchive",
  "group_archive",
  "group_unarchive",
  "channel_rename",
  "group_rename",
  "channel_deleted",
  "group_deleted",
  "channel_shared",
  "channel_unshared",
  "app_uninstalled",
  "tokens_revoked",
] as const;

/**
 * `agent`: one app per agent, created by the platform. `link`: the
 * workspace's account-linking app, also platform-made. `manual`: an app a
 * person made, whose secrets a person enters.
 */
export const SLACK_APP_KIND_VALUES = ["agent", "link", "manual"] as const;

/**
 * `creating` is written before Slack is asked, so a lost answer leaves a
 * trace instead of a second app. `failed`: Slack refused, no app exists.
 * `abandoned`: a `creating` row a person chose to give up on; Slack may
 * still hold that app.
 */
export const SLACK_APP_STATE_VALUES = [
  "creating",
  "created",
  "failed",
  "abandoned",
  "deleting",
  "deleted",
] as const;

/** Every purpose but the workspace's config token. */
export const SLACK_APP_SECRET_PURPOSE_VALUES = [
  "slack_signing_secret",
  "slack_client_secret",
  "slack_bot_token",
] as const satisfies readonly (typeof SECRET_PURPOSE_VALUES)[number][];

export const slackAppKindSchema = z.enum(SLACK_APP_KIND_VALUES);
export const slackAppStateSchema = z.enum(SLACK_APP_STATE_VALUES);
export const slackAppSecretPurposeSchema = z.enum(
  SLACK_APP_SECRET_PURPOSE_VALUES,
);
export const slackAppIdSchema = z.uuid();

export const slackAppSchema = z
  .object({
    id: slackAppIdSchema,
    kind: slackAppKindSchema,
    agent_id: agentIdSchema.nullable(),
    state: slackAppStateSchema,
    /** Slack's app id; null until Slack has answered the create call. */
    app_id: slackIdSchema.nullable(),
    client_id: z.string().min(1).max(64).nullable(),
    redirect_url: z.url(),
    /** The Slack user whose config token created the app (its collaborator). */
    created_by_token_user: slackIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    /** Whether each secret is stored; never the values. */
    secrets: z
      .object({
        slack_signing_secret: slackSecretSummarySchema,
        slack_client_secret: slackSecretSummarySchema,
        slack_bot_token: slackSecretSummarySchema,
      })
      .strict(),
  })
  .strict();

/**
 * Something the caller should know that did not stop the request: the
 * config token now belongs to another Slack user, who becomes each new
 * app's collaborator. On a create, `previous_user_id` made the workspace's
 * previous app; on a read, it made this app, which the new user may not be
 * able to manage or install.
 */
export const slackWarningSchema = z
  .object({
    code: z.literal("config_token_issuer_changed"),
    previous_user_id: slackIdSchema,
    user_id: slackIdSchema,
  })
  .strict();

/**
 * Why the agent's Slack mentions and DMs are refused with a notice while
 * connecting still goes ahead. `repository_required`: the active release
 * needs a repository and names none, or its GitHub settings cannot be read.
 * `release_unavailable`: the active release's connection is disabled or
 * gone, or its model left the connection's list. `no_active_release`:
 * nothing is activated yet.
 */
export const slackAgentWarningSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("repository_required"),
      release_id: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("release_unavailable"),
      release_id: z.string(),
    })
    .strict(),
  z.object({ code: z.literal("no_active_release") }).strict(),
]);

export const createSlackAppRequestSchema = z
  .object({
    /**
     * Give up on an earlier creation whose answer was lost (409
     * SLACK_APP_CREATING with `uncertain: true`) after checking Slack holds
     * no such app, and create a new one.
     */
    replace_uncertain: z.boolean().default(false),
  })
  .strict();

export const createSlackAppResponseSchema = z
  .object({
    slack_app: slackAppSchema,
    /** False when the agent already had this app. */
    created: z.boolean(),
    warnings: z.array(
      z.discriminatedUnion("code", [
        slackWarningSchema,
        ...slackAgentWarningSchema.options,
      ]),
    ),
  })
  .strict();

export const CONFIG_TOKEN_STATE_VALUES = [
  "unset",
  "active",
  "needs_reentry",
] as const;

export const getSlackAppResponseSchema = z
  .object({
    slack_app: slackAppSchema.nullable(),
    event_url: z.url().nullable(),
    events: z
      .object({
        state: z.enum(["verified", "pending", "failed"]),
        checked_at: timestampSchema.nullable(),
        /** The Request URL last sent to Slack; null while none has been. */
        url: z.url().nullable(),
        error: z.string().max(128).optional(),
        /**
         * When a request signed by the app last arrived, kept to within a
         * minute; absent before any. `state` stays `verified` when Slack stops sending.
         */
        last_received_at: timestampSchema.optional(),
      })
      .strict(),
    warnings: z.array(
      z.discriminatedUnion("code", [
        slackWarningSchema,
        ...slackAgentWarningSchema.options,
      ]),
    ),
    /**
     * The workspace's App Configuration Token, so a console can say why an
     * app cannot be made before asking; only `active` can make one.
     */
    config_token: z.enum(CONFIG_TOKEN_STATE_VALUES),
  })
  .strict();

/**
 * `reinstall_required`: Slack answered the manifest update with
 * `permissions_updated` (the manifest asks for a scope the install lacks),
 * so the app must be installed again before the new scopes apply.
 */
export const recheckSlackAppEventsResponseSchema = getSlackAppResponseSchema
  .extend({ reinstall_required: z.boolean() })
  .strict();

export const slackAppSettingsSchema = z
  .object({
    // Every channel in use, connected before or after, follows it; DMs do not.
    mention_only: z.boolean(),
  })
  .strict();

/** How many bots one agent answers; a handful is all agents talk with. */
export const SLACK_ALLOWED_BOTS_MAX = 20;

/**
 * Bot-started turns one Slack thread runs in a row with no person writing
 * there; the next bot mention stops it (the `botTurnLimit` notice names it).
 */
export const SLACK_BOT_TURN_LIMIT = 5;

/** `gone`: Slack deleted or deactivated the bot, or no longer lists it. */
export const SLACK_BOT_STATE_VALUES = ["active", "gone"] as const;

/** A bot of the agent's Slack workspace, and whether the agent answers it. */
export const slackBotSchema = z
  .object({
    user_id: slackIdSchema,
    /** Null when Slack lists it no longer. */
    name: z.string().min(1).max(255).nullable(),
    state: z.enum(SLACK_BOT_STATE_VALUES),
    allowed: z.boolean(),
  })
  .strict();

export const getSlackAppBotsResponseSchema = z
  .object({
    /** The workspace's live bots, then the allowed ones that are gone. */
    items: z.array(slackBotSchema),
    /**
     * Slack's list was longer than what was read: a bot missing from
     * `items` can still be added by its user id.
     */
    truncated: z.boolean(),
  })
  .strict();

/**
 * Why a bot id was refused: the agent's own, another agent's of this Werft
 * install, another team's, no bot.
 */
export const SLACK_BOT_REFUSAL_VALUES = [
  "slack_bot_own",
  "slack_bot_werft_agent",
  "slack_bot_other_team",
  "slack_bot_unknown",
] as const;

export const putSlackAppBotsRequestSchema = z
  .object({
    allowed_user_ids: z
      .array(slackIdSchema)
      .max(SLACK_ALLOWED_BOTS_MAX)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "must not repeat a bot",
      }),
  })
  .strict();

export type SlackBot = z.infer<typeof slackBotSchema>;
export type SlackBotRefusal = (typeof SLACK_BOT_REFUSAL_VALUES)[number];
export type GetSlackAppBotsResponse = z.infer<
  typeof getSlackAppBotsResponseSchema
>;
export type PutSlackAppBotsRequest = z.infer<
  typeof putSlackAppBotsRequestSchema
>;

export const getSlackAppManifestResponseSchema = z
  .object({
    manifest_yaml: z.string(),
  })
  .strict();

export type SlackAppSettings = z.infer<typeof slackAppSettingsSchema>;

export const slackAppParamsSchema = workspaceParamsSchema
  .extend({ app_id: slackAppIdSchema })
  .strict();

export const slackAppSecretParamsSchema = slackAppParamsSchema
  .extend({ purpose: slackAppSecretPurposeSchema })
  .strict();

/** The Slack calls a delete makes once Werft's side is closed, each once. */
export const SLACK_APP_CLEANUP_STEP_VALUES = [
  "auth.revoke",
  "apps.manifest.delete",
] as const;

/**
 * What the Slack side of a delete came to. `failed`: the steps named did
 * not go through and are not tried again, so the app may still be in Slack;
 * the delete stands.
 */
export const slackAppCleanupSchema = z
  .object({
    outcome: z.enum(["done", "failed"]),
    failed_steps: z.array(z.enum(SLACK_APP_CLEANUP_STEP_VALUES)),
    message: z.string().nullable(),
  })
  .strict();

export const deleteSlackAppResponseSchema = z
  .object({
    slack_app: slackAppSchema,
    /** Null when the app was already deleted: nothing was tried again. */
    slack_cleanup: slackAppCleanupSchema.nullable(),
  })
  .strict();

/**
 * The apps this console made in the workspace and still keeps: agent apps
 * and the account-link app, not ones failed, abandoned or deleted.
 */
export const listWorkspaceSlackAppsResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          slack_app: slackAppSchema,
          /** Null for the account-link app. */
          agent: z
            .object({
              id: agentIdSchema,
              name: z.string(),
              slug: z.string(),
              /** Whether the agent's bot is installed in Slack now. */
              installed: z.boolean(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The addresses Slack is sent to, computed from the console's public origin
 * (CONSOLE_ORIGIN) and fixed paths. An operator copies them into a Slack app
 * made by hand. Null when the origin is unset, or (events) when Slack could
 * not reach it.
 */
export const slackPublicUrlsSchema = z
  .object({
    /** Where Sign in with Slack sends the browser back. */
    redirect_url: z.string().nullable(),
    /** `{agent_id}` stands for the agent's id: one events URL per agent. */
    events_url_template: z.string().nullable(),
  })
  .strict();

/**
 * The config token as the console shows it. `needs_reentry`: Slack no
 * longer takes the stored pair, or a rotation's result was lost; an owner
 * or admin pastes a new token.
 */
export const slackConfigTokenSummarySchema = slackSecretSummarySchema
  .extend({
    urls: slackPublicUrlsSchema,
    state: z.enum(CONFIG_TOKEN_STATE_VALUES),
    /** When the current access token expires; it is rotated before then. */
    expires_at: timestampSchema.nullable(),
    issuer: z
      .object({ user_id: slackIdSchema, team_id: slackIdSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const putSlackConfigTokenResponseSchema = slackConfigTokenSummarySchema
  .extend({
    receipt_id: z.uuid(),
    warnings: z.array(slackWarningSchema),
  })
  .strict();

/**
 * Where Slack's event and interaction requests enter, for the whole
 * installation. `events_public_url` is what an owner saved: set only when
 * they enter apart from the console; null means the base computed from
 * CONSOLE_ORIGIN (`computed_events_base`, null when Slack could not reach
 * it). `events_url_template` is what Slack is sent, from whichever applies.
 */
export const slackSettingsSchema = z
  .object({
    events_public_url: z.string().nullable(),
    computed_events_base: z.string().nullable(),
    events_url_template: z.string().nullable(),
  })
  .strict();

/** The longest events address kept. */
export const SLACK_EVENTS_PUBLIC_URL_MAX = 2048;

/**
 * An absolute https URL without a query, fragment or credentials; a path
 * prefix is kept. Null clears it.
 */
export const updateSlackSettingsRequestSchema = z
  .object({
    events_public_url: z.string().max(SLACK_EVENTS_PUBLIC_URL_MAX).nullable(),
  })
  .strict();

export const updateSlackSettingsResponseSchema = slackSettingsSchema
  .extend({
    /** Only when the saved address changed. */
    receipt_id: z.uuid().optional(),
  })
  .strict();

export type SlackSettings = z.infer<typeof slackSettingsSchema>;
export type UpdateSlackSettingsRequest = z.infer<
  typeof updateSlackSettingsRequestSchema
>;
export type UpdateSlackSettingsResponse = z.infer<
  typeof updateSlackSettingsResponseSchema
>;
export type SlackAppKind = z.infer<typeof slackAppKindSchema>;
export type SlackAppState = z.infer<typeof slackAppStateSchema>;
export type SlackAppSecretPurpose = z.infer<typeof slackAppSecretPurposeSchema>;
export type SlackApp = z.infer<typeof slackAppSchema>;
export type SlackWarning = z.infer<typeof slackWarningSchema>;
export type SlackAgentWarning = z.infer<typeof slackAgentWarningSchema>;
export type CreateSlackAppRequest = z.infer<typeof createSlackAppRequestSchema>;
export type CreateSlackAppResponse = z.infer<
  typeof createSlackAppResponseSchema
>;
export type GetSlackAppResponse = z.infer<typeof getSlackAppResponseSchema>;
export type RecheckSlackAppEventsResponse = z.infer<
  typeof recheckSlackAppEventsResponseSchema
>;
export type DeleteSlackAppResponse = z.infer<
  typeof deleteSlackAppResponseSchema
>;
export type SlackAppCleanup = z.infer<typeof slackAppCleanupSchema>;
export type SlackAppCleanupStep =
  (typeof SLACK_APP_CLEANUP_STEP_VALUES)[number];
export type ListWorkspaceSlackAppsResponse = z.infer<
  typeof listWorkspaceSlackAppsResponseSchema
>;
export type SlackPublicUrls = z.infer<typeof slackPublicUrlsSchema>;
export type SlackConfigTokenSummary = z.infer<
  typeof slackConfigTokenSummarySchema
>;
export type PutSlackConfigTokenResponse = z.infer<
  typeof putSlackConfigTokenResponseSchema
>;
