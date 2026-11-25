import { BOT_SCOPES, SLACK_AGENT_BOT_EVENTS } from "@werft-ai/contracts";
import { z } from "zod";

// Slack's limits on what a manifest may say about an app.
const APP_NAME_MAX = 35;
const BOT_NAME_MAX = 80;
const AGENT_DESCRIPTION_MAX = 300;

// Slack requires agent_description whenever agent_view is present and rejects
// an empty one as invalid_manifest, so the field cannot be dropped.
export const AGENT_DESCRIPTION_FALLBACK = "Werft 에이전트";

export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

export type AgentAppManifestInput = {
  /** The agent's name, shown as the app's. */
  name: string;
  /** The agent's slug: a bot display name allows only a-z, 0-9, `-_.`. */
  botName: string;
  /** The active release card's role, else the agent's description; may be empty. */
  description: string;
  redirectUrl: string;
  /**
   * The events route for this agent; its interactions route sits beside
   * it. Absent at creation: Slack checks the
   * URL with a challenge signed by a secret the app does not have yet, so
   * Finalize adds it once the route can answer.
   */
  eventsUrl?: string;
};

export function slackInteractionsUrlOf(eventsUrl: string): string {
  // The route's own segment, last: a saved base's path prefix may repeat it.
  return eventsUrl.replace(
    /\/v1\/slack\/events\/([^/]+)$/,
    "/v1/slack/interactions/$1",
  );
}

const clip = (value: string, max: number) =>
  [...value].length > max ? [...value].slice(0, max).join("") : value;

/**
 * Always the whole manifest: `apps.manifest.update` replaces the document,
 * so the update Finalize sends must carry everything creation did. The
 * agent app has no user scopes; Sign in with Slack is the link app's.
 */
export function buildAgentAppManifest(input: AgentAppManifestInput) {
  const name = clip(input.name.trim(), APP_NAME_MAX);
  return {
    display_information: { name },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: clip(input.botName, BOT_NAME_MAX),
        always_online: true,
      },
      agent_view: {
        agent_description: clip(
          input.description.trim() || AGENT_DESCRIPTION_FALLBACK,
          AGENT_DESCRIPTION_MAX,
        ),
      },
    },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      ...(input.eventsUrl === undefined
        ? {}
        : {
            event_subscriptions: {
              request_url: input.eventsUrl,
              bot_events: [...SLACK_AGENT_BOT_EVENTS],
            },
            interactivity: {
              is_enabled: true,
              request_url: slackInteractionsUrlOf(input.eventsUrl),
            },
          }),
    },
  };
}

// Only what the comparison reads; Slack's manifest says much more.
const exportedManifestSchema = z.object({
  oauth_config: z
    .object({
      scopes: z
        .object({
          bot: z.array(z.string()).optional(),
          user: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  settings: z
    .object({
      event_subscriptions: z
        .object({ bot_events: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
});

/**
 * How an exported agent app manifest differs from what this build sends.
 * `events`: only the bot events differ, which Slack takes without a new
 * install. `scopes`: the bot scopes differ, or the app has user scopes an
 * agent app never asks for; either needs an install, so nothing is sent on
 * its own. `unsubscribed`: no event subscription yet, which
 * Finalize adds. `unreadable`: not a manifest this code can read.
 */
export type AgentManifestDrift =
  | "current"
  | "events"
  | "scopes"
  | "unsubscribed"
  | "unreadable";

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
};

export function agentManifestDrift(exported: unknown): AgentManifestDrift {
  const parsed = exportedManifestSchema.safeParse(exported);
  if (!parsed.success) return "unreadable";
  const subscription = parsed.data.settings?.event_subscriptions;
  if (subscription === undefined) return "unsubscribed";
  const scopes = parsed.data.oauth_config?.scopes;
  if (!sameSet(scopes?.bot ?? [], BOT_SCOPES) || (scopes?.user ?? []).length)
    return "scopes";
  return sameSet(subscription.bot_events ?? [], SLACK_AGENT_BOT_EVENTS)
    ? "current"
    : "events";
}

/**
 * The bot scopes this build asks for that an install's grant lacks; null
 * when the grant is not known.
 */
export function slackMissingScopes(
  granted: readonly string[] | null | undefined,
): string[] | null {
  if (granted === null || granted === undefined) return null;
  return BOT_SCOPES.filter((scope) => !granted.includes(scope));
}

/**
 * Whether what needs `scope` may run on this app: only once its install is
 * known to hold it, so a scope added after the install stays off until an
 * admin approves the install again.
 */
export function slackAppGrants(
  app: { readonly botScopes?: readonly string[] | null },
  scope: string,
): boolean {
  return app.botScopes?.includes(scope) ?? false;
}

/** The console page Slack sends the installer back to. */
export function slackAppRedirectUrl(
  consoleOrigin: string,
  agentId: string,
): string {
  return new URL(
    `/agents/${encodeURIComponent(agentId.toLowerCase())}/slack/callback`,
    consoleOrigin,
  ).toString();
}

/**
 * Where a workspace admin approves installing the app. The OAuth `state`
 * that binds the answer to its requester is added by the install flow.
 */
export function slackAuthorizeUrl(input: {
  clientId: string;
  redirectUrl: string;
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: BOT_SCOPES.join(","),
    redirect_uri: input.redirectUrl,
  });
  if (input.state !== undefined) params.set("state", input.state);
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** What the link app's consent screen asks for: who the person is, no email. */
export const SLACK_LINK_USER_SCOPES = ["openid", "profile"] as const;

/** The link app's words in Slack, kept together for copy review. */
export const LINK_APP_COPY = {
  nameSuffix: " 계정 연결",
  description: "Werft 콘솔에서 Slack 계정을 연결합니다.",
} as const;

/**
 * The workspace's account-linking app: Sign in with Slack only, so no bot,
 * no bot scopes and no events. The workspace's name is cut, not the
 * suffix, to fit Slack's limit.
 */
export function buildLinkAppManifest(input: {
  workspaceName: string;
  redirectUrl: string;
}) {
  const suffix = LINK_APP_COPY.nameSuffix;
  const name = `${clip(input.workspaceName.trim(), APP_NAME_MAX - [...suffix].length).trim()}${suffix}`;
  return {
    display_information: { name, description: LINK_APP_COPY.description },
    oauth_config: {
      redirect_urls: [input.redirectUrl],
      scopes: { user: [...SLACK_LINK_USER_SCOPES] },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/** The console page Sign in with Slack returns to. */
export function slackLinkRedirectUrl(consoleOrigin: string): string {
  return new URL("/settings/linked-accounts/slack", consoleOrigin).toString();
}
