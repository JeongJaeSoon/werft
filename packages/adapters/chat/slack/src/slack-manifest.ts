import { BOT_SCOPES, SLACK_AGENT_BOT_EVENTS } from "@werft-ai/contracts";

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
  return eventsUrl.replace(/\/v1\/slack\/events\//, "/v1/slack/interactions/");
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
