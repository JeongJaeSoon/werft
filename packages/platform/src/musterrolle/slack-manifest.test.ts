import { describe, expect, test } from "bun:test";
import { BOT_SCOPES, SLACK_AGENT_BOT_EVENTS } from "@werft-ai/contracts";
import {
  buildAgentAppManifest,
  buildLinkAppManifest,
  LINK_APP_COPY,
  slackAppRedirectUrl,
  slackAuthorizeUrl,
  slackLinkRedirectUrl,
} from "./slack-manifest.ts";

const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const REDIRECT = `https://console.example.ts.net/agents/${AGENT}/slack/callback`;

describe("agent app manifest", () => {
  test("the bot scopes are exactly these: adding one grants Slack authority", () => {
    expect([...BOT_SCOPES]).toEqual([
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
    ]);
  });

  test("Finalize subscribes to these events, the bot's join and leave included", () => {
    expect([...SLACK_AGENT_BOT_EVENTS]).toEqual([
      "app_mention",
      "message.im",
      "message.channels",
      "message.groups",
      "member_joined_channel",
      "member_left_channel",
      "app_uninstalled",
      "tokens_revoked",
    ]);
  });

  test("the creation manifest, whole", () => {
    expect(
      buildAgentAppManifest({
        name: "Release notes",
        botName: "release-notes",
        description: "Writes the release notes",
        redirectUrl: REDIRECT,
      }),
    ).toEqual({
      display_information: { name: "Release notes" },
      features: {
        app_home: {
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: "release-notes", always_online: true },
        agent_view: { agent_description: "Writes the release notes" },
      },
      oauth_config: {
        redirect_urls: [REDIRECT],
        scopes: { bot: [...BOT_SCOPES] },
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  });

  test("creation has no event_subscriptions key at all and no user scopes", () => {
    const manifest = buildAgentAppManifest({
      name: "a",
      botName: "a",
      description: "a",
      redirectUrl: REDIRECT,
    });
    expect(Object.keys(manifest.settings)).not.toContain("event_subscriptions");
    expect(Object.keys(manifest.settings)).not.toContain("interactivity");
    expect(Object.keys(manifest.oauth_config.scopes)).toEqual(["bot"]);
  });

  test("the full update manifest carries the events route and the Finalize list", () => {
    const manifest = buildAgentAppManifest({
      name: "a",
      botName: "a",
      description: "a",
      redirectUrl: REDIRECT,
      eventsUrl: `https://agents.example.ts.net/v1/slack/events/${AGENT}`,
    });
    expect(manifest.settings).toMatchObject({
      event_subscriptions: {
        request_url: `https://agents.example.ts.net/v1/slack/events/${AGENT}`,
        bot_events: [...SLACK_AGENT_BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
        request_url: `https://agents.example.ts.net/v1/slack/interactions/${AGENT}`,
      },
    });
  });

  test("names and the description are clipped to Slack's limits", () => {
    const manifest = buildAgentAppManifest({
      name: "가".repeat(50),
      botName: "b".repeat(100),
      description: "d".repeat(400),
      redirectUrl: REDIRECT,
    });
    expect([...manifest.display_information.name]).toHaveLength(35);
    expect(manifest.features.bot_user.display_name).toHaveLength(80);
    expect(manifest.features.agent_view.agent_description).toHaveLength(300);
  });

  test("the redirect is the console's callback page for the agent", () => {
    expect(
      slackAppRedirectUrl(
        "https://console.example.ts.net",
        AGENT.toUpperCase(),
      ),
    ).toBe(REDIRECT);
  });

  test("the authorize URL asks for the bot scopes and no user scopes", () => {
    const url = new URL(
      slackAuthorizeUrl({ clientId: "1000.1", redirectUrl: REDIRECT }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "1000.1",
      scope: BOT_SCOPES.join(","),
      redirect_uri: REDIRECT,
    });
  });
});

describe("link app manifest", () => {
  const LINK_REDIRECT =
    "https://console.example.ts.net/settings/linked-accounts/slack";

  test("the redirect is the console's linked-accounts page", () => {
    expect(slackLinkRedirectUrl("https://console.example.ts.net")).toBe(
      LINK_REDIRECT,
    );
  });

  test("the whole manifest: user scopes openid and profile only, no bot, no events", () => {
    const manifest = buildLinkAppManifest({
      workspaceName: "Acme",
      redirectUrl: LINK_REDIRECT,
    });
    expect(manifest).toEqual({
      display_information: {
        name: `Acme${LINK_APP_COPY.nameSuffix}`,
        description: LINK_APP_COPY.description,
      },
      oauth_config: {
        redirect_urls: [LINK_REDIRECT],
        scopes: { user: ["openid", "profile"] },
      },
      settings: {
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
    expect(manifest.oauth_config.scopes).not.toHaveProperty("bot");
    expect(manifest).not.toHaveProperty("features");
  });

  test("the words are these, under review as one constant", () => {
    expect(LINK_APP_COPY).toEqual({
      nameSuffix: " 계정 연결",
      description: "Werft 콘솔에서 Slack 계정을 연결합니다.",
    });
  });

  test("a long workspace name is cut to Slack's 35, keeping the suffix", () => {
    const manifest = buildLinkAppManifest({
      workspaceName: "Department of Very Long Workspace Names 한국어",
      redirectUrl: LINK_REDIRECT,
    });
    expect(manifest.display_information.name).toMatchInlineSnapshot(
      `"Department of Very Long Works 계정 연결"`,
    );
    expect([...manifest.display_information.name]).toHaveLength(35);
  });
});
