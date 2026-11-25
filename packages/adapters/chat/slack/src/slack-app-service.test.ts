import { describe, expect, test } from "bun:test";
import {
  SLACK_AGENT_BOT_EVENTS,
  type SlackAgentWarning,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "@werft-ai/platform";
import { refusal } from "@werft-ai/platform/testing/refusal";
import {
  createSlackAppService,
  SLACK_APP_CREATE_STALE_MS,
  SLACK_MANIFEST_CHECK_STALE_MS,
} from "./slack-app-service.ts";
import {
  SLACK_HTTP_TIMEOUT_MS,
  SlackApiError,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import { createSlackConfigTokens } from "./slack-config-token.ts";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
} from "./testing/slack-fakes.ts";

test("a creation is uncertain only after the Slack call could have ended", () => {
  expect(SLACK_APP_CREATE_STALE_MS).toBeGreaterThan(SLACK_HTTP_TIMEOUT_MS);
});

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const IDLE_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const ORIGIN = "https://console.example.ts.net";

test("event registration results persist across reads and expose only a safe error", async () => {
  const { service, slack } = await setup();
  const caller = user("owner");
  const created = await service.createAgentApp(caller, AGENT, {
    replace_uncertain: false,
  });
  const input = {
    name: "Release notes",
    botName: "release-notes",
    description: "Writes the release notes",
    eventsUrl: `https://events.example.test/v1/slack/events/${AGENT}`,
  };
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "pending",
    checked_at: null,
    url: null,
  });
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input);
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "pending",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: input.eventsUrl,
  });
  slack.api.updateApp = async () => {
    throw new SlackApiError("apps.manifest.update", "invalid_manifest", true);
  };
  await expect(
    service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input),
  ).rejects.toThrow();
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "failed",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: input.eventsUrl,
    error: "events_registration_failed",
  });
});

test("a reinstall keeps a verified URL verified, also when the URL moves, until Slack refuses the move", async () => {
  const { service, apps, slack } = await setup();
  const caller = user("owner");
  const created = await service.createAgentApp(caller, AGENT, {
    replace_uncertain: false,
  });
  const input = {
    name: "Release notes",
    botName: "release-notes",
    description: "Writes the release notes",
    eventsUrl: `https://events.example.test/v1/slack/events/${AGENT}`,
  };
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input);
  await apps.store.setEventsUnlessVerified(WORKSPACE, created.slack_app.id, {
    state: "verified",
    checked_at: "2026-10-23T00:00:01.000Z",
  });
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input);
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "verified",
    checked_at: "2026-10-23T00:00:01.000Z",
    url: input.eventsUrl,
  });
  // Slack moves a verified Request URL without sending a url_verification
  // to the new one, so nothing would ever settle a `pending` here.
  const moved = `https://moved.example.test/v1/slack/events/${AGENT}`;
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
    ...input,
    eventsUrl: moved,
  });
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "verified",
    checked_at: "2026-10-23T00:00:01.000Z",
    url: moved,
  });
  slack.api.updateApp = async () => {
    throw new SlackApiError("apps.manifest.update", "invalid_manifest", true);
  };
  const again = `https://again.example.test/v1/slack/events/${AGENT}`;
  await expect(
    service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
      ...input,
      eventsUrl: again,
    }),
  ).rejects.toThrow();
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "failed",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: again,
    error: "events_registration_failed",
  });
});

test("a verified app keeps verified when a move goes unanswered, and fails when Slack refuses a move after a late check", async () => {
  const { service, apps, slack } = await setup();
  const caller = user("owner");
  const created = await service.createAgentApp(caller, AGENT, {
    replace_uncertain: false,
  });
  const input = {
    name: "Release notes",
    botName: "release-notes",
    description: "Writes the release notes",
    eventsUrl: `https://events.example.test/v1/slack/events/${AGENT}`,
  };
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input);
  const verified = {
    state: "verified",
    checked_at: "2026-10-23T00:00:01.000Z",
  } as const;
  await apps.store.setEventsUnlessVerified(
    WORKSPACE,
    created.slack_app.id,
    verified,
  );
  // The new URL may already have answered Slack's check.
  slack.api.updateApp = async () => {
    throw new SlackApiError("apps.manifest.update", "timeout", false);
  };
  const moved = `https://moved.example.test/v1/slack/events/${AGENT}`;
  await expect(
    service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
      ...input,
      eventsUrl: moved,
    }),
  ).rejects.toThrow();
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    ...verified,
    url: moved,
  });
  // Pending when read, verified by the old URL's check before Slack refuses.
  await apps.store.setEvents(WORKSPACE, created.slack_app.id, {
    state: "pending",
    checked_at: "2026-10-23T00:00:02.000Z",
  });
  slack.api.updateApp = async () => {
    await apps.store.setEventsUnlessVerified(
      WORKSPACE,
      created.slack_app.id,
      verified,
    );
    throw new SlackApiError("apps.manifest.update", "invalid_manifest", true);
  };
  const again = `https://again.example.test/v1/slack/events/${AGENT}`;
  await expect(
    service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
      ...input,
      eventsUrl: again,
    }),
  ).rejects.toThrow();
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "failed",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: again,
    error: "events_registration_failed",
  });
  // A refused token never moved the URL either.
  await apps.store.setEvents(WORKSPACE, created.slack_app.id, verified);
  slack.api.updateApp = async () => {
    throw new SlackApiError("apps.manifest.update", "token_revoked", true);
  };
  const third = `https://third.example.test/v1/slack/events/${AGENT}`;
  await expect(
    service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
      ...input,
      eventsUrl: third,
    }),
  ).rejects.toThrow();
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "failed",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: third,
    error: "events_registration_failed",
  });
});

test("a pending app whose URL moves stays pending", async () => {
  const { service } = await setup();
  const caller = user("owner");
  const created = await service.createAgentApp(caller, AGENT, {
    replace_uncertain: false,
  });
  const input = {
    name: "Release notes",
    botName: "release-notes",
    description: "Writes the release notes",
    eventsUrl: `https://events.example.test/v1/slack/events/${AGENT}`,
  };
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, input);
  const moved = `https://moved.example.test/v1/slack/events/${AGENT}`;
  await service.updateAgentAppManifest(WORKSPACE, created.slack_app.id, {
    ...input,
    eventsUrl: moved,
  });
  expect((await service.getAgentApp(caller, AGENT)).events).toEqual({
    state: "pending",
    checked_at: "2026-10-23T00:00:00.000Z",
    url: moved,
  });
});

test("the read tells an agent admin whether the config token can create an app", async () => {
  const { service, tokenStore } = await setup();
  const agentAdmin = user("member", { id: AGENT_ADMIN });
  expect((await service.getAgentApp(agentAdmin, AGENT)).config_token).toBe(
    "active",
  );
  await tokenStore.store.invalidate(WORKSPACE, null);
  expect((await service.getAgentApp(agentAdmin, AGENT)).config_token).toBe(
    "needs_reentry",
  );
  await tokenStore.store.delete(WORKSPACE, {
    principal: user("owner"),
    receiptId: crypto.randomUUID(),
    roles: ["owner", "admin"],
  });
  expect((await service.getAgentApp(agentAdmin, AGENT)).config_token).toBe(
    "unset",
  );
});

test("a recheck sends the Request URL to Slack again and needs the public events address", async () => {
  const unset = await setup();
  await unset.service.createAgentApp(user("owner"), AGENT, {
    replace_uncertain: false,
  });
  expect(
    await refusal(unset.service.recheckAgentAppEvents(user("owner"), AGENT)),
  ).toMatchObject({
    code: "BACKEND_UNAVAILABLE",
    details: { reason_code: "events_url_unset" },
  });

  const { service, slack } = await setup({
    eventsPublicUrl: "https://events.example.test/",
  });
  await service.createAgentApp(user("owner"), AGENT, {
    replace_uncertain: false,
  });
  const url = `https://events.example.test/v1/slack/events/${AGENT}`;
  const read = await service.recheckAgentAppEvents(user("owner"), AGENT);
  expect(read.events).toEqual({
    state: "pending",
    checked_at: "2026-10-23T00:00:00.000Z",
    url,
  });
  expect(
    JSON.stringify(slack.state.apps.get(read.slack_app?.app_id ?? "")),
  ).toContain(url);
  expect(
    await refusal(service.recheckAgentAppEvents(user("owner"), IDLE_AGENT)),
  ).toMatchObject({ code: "NOT_FOUND" });
});

test("a recheck says when Slack answers that the app's permissions changed", async () => {
  const { service, slack } = await setup({
    eventsPublicUrl: "https://events.example.test/",
  });
  await service.createAgentApp(user("owner"), AGENT, {
    replace_uncertain: false,
  });
  expect(
    (await service.recheckAgentAppEvents(user("owner"), AGENT))
      .reinstall_required,
  ).toBe(false);
  slack.state.permissionsUpdated = true;
  expect(
    (await service.recheckAgentAppEvents(user("owner"), AGENT))
      .reinstall_required,
  ).toBe(true);
});

test.each([
  ["answers", false],
  ["is lost", true],
])(
  "a challenge Slack answers while the manifest update %s keeps the subscription verified",
  async (_, lost) => {
    const { service, slack, apps } = await setup();
    const created = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const update = slack.api.updateApp;
    slack.api.updateApp = async (...args) => {
      await apps.store.setEventsUnlessVerified(
        WORKSPACE,
        created.slack_app.id,
        {
          state: "verified",
          checked_at: "2026-10-23T00:00:01.000Z",
        },
      );
      if (lost)
        throw new SlackApiError("apps.manifest.update", "timeout", false);
      return update(...args);
    };
    const updating = service.updateAgentAppManifest(
      WORKSPACE,
      created.slack_app.id,
      {
        name: "Release notes",
        botName: "release-notes",
        description: "Writes the release notes",
        eventsUrl: `https://events.example.test/v1/slack/events/${AGENT}`,
      },
    );
    if (lost) await expect(updating).rejects.toThrow();
    else await updating;
    expect((await service.getAgentApp(user("owner"), AGENT)).events).toEqual({
      state: "verified",
      checked_at: "2026-10-23T00:00:01.000Z",
      url: `https://events.example.test/v1/slack/events/${AGENT}`,
    });
  },
);

type ExportedManifest = {
  oauth_config: { scopes: { bot: string[] } };
  settings: { event_subscriptions?: { bot_events: string[] } };
};

function manifestOf(
  slack: Awaited<ReturnType<typeof setup>>["slack"],
  appId: string,
): ExportedManifest {
  const app = slack.state.apps.get(appId);
  if (!app) throw new Error(`no fake app ${appId}`);
  return app.manifest as ExportedManifest;
}

/** Slack holds the app as an older build left it: one event short. */
function dropEvent(
  slack: Awaited<ReturnType<typeof setup>>["slack"],
  appId: string,
  event = "channel_shared",
) {
  const app = slack.state.apps.get(appId);
  if (!app) throw new Error(`no fake app ${appId}`);
  const manifest = structuredClone(app.manifest) as ExportedManifest;
  const subscription = manifest.settings.event_subscriptions;
  if (!subscription) throw new Error("the app has no event subscription");
  subscription.bot_events = subscription.bot_events.filter((e) => e !== event);
  app.manifest = manifest;
}

/** An app made and finalized, its last check old enough for a start to take it. */
async function subscribedApp(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup({
    eventsPublicUrl: "https://events.example.test/",
    ...options,
  });
  await ctx.service.createAgentApp(user("owner"), AGENT, {
    replace_uncertain: false,
  });
  const read = await ctx.service.recheckAgentAppEvents(user("owner"), AGENT);
  const appId = read.slack_app?.app_id;
  if (!appId) throw new Error("the app has no Slack app id");
  ctx.advance(SLACK_MANIFEST_CHECK_STALE_MS + 1);
  const calls = (method: string) =>
    ctx.slack.state.calls.filter((call) => call.method === method).length;
  const sync = async () =>
    (await ctx.service.getAgentApp(user("owner"), AGENT)).manifest_sync;
  return { ...ctx, appId, calls, sync };
}

describe("manifest check at a start of the API", () => {
  test("an app whose manifest lacks only events is sent the whole manifest", async () => {
    const { service, slack, appId, calls, sync } = await subscribedApp();
    dropEvent(slack, appId);
    const updates = calls("apps.manifest.update");
    expect(await service.syncAgentAppManifests()).toEqual({
      checked: 1,
      sent: 1,
      failed: 0,
    });
    expect(calls("apps.manifest.update")).toBe(updates + 1);
    const sent = manifestOf(slack, appId);
    expect(sent.settings.event_subscriptions?.bot_events).toEqual([
      ...SLACK_AGENT_BOT_EVENTS,
    ]);
    // The whole document: Slack replaces it on update.
    expect(sent).toMatchObject({
      display_information: { name: "Release notes" },
      settings: {
        event_subscriptions: {
          request_url: `https://events.example.test/v1/slack/events/${AGENT}`,
        },
      },
    });
    expect(await sync()).toEqual({
      error: null,
      checked_at: "2026-10-23T00:10:00.001Z",
    });
  });

  test("a current manifest is read and not sent again", async () => {
    const { service, calls, sync } = await subscribedApp();
    const updates = calls("apps.manifest.update");
    expect(await service.syncAgentAppManifests()).toEqual({
      checked: 1,
      sent: 0,
      failed: 0,
    });
    expect(calls("apps.manifest.export")).toBe(1);
    expect(calls("apps.manifest.update")).toBe(updates);
    expect((await sync())?.error).toBeNull();
  });

  test("an app whose bot scopes differ is left for an admin's install", async () => {
    const { service, slack, appId, calls } = await subscribedApp();
    dropEvent(slack, appId);
    manifestOf(slack, appId).oauth_config.scopes.bot = ["chat:write"];
    const updates = calls("apps.manifest.update");
    expect((await service.syncAgentAppManifests()).sent).toBe(0);
    expect(calls("apps.manifest.update")).toBe(updates);
  });

  test("an app with no event subscription is left for Finalize", async () => {
    const { service, slack, appId, calls } = await subscribedApp();
    delete manifestOf(slack, appId).settings.event_subscriptions;
    const updates = calls("apps.manifest.update");
    expect((await service.syncAgentAppManifests()).sent).toBe(0);
    expect(calls("apps.manifest.update")).toBe(updates);
  });

  test("without an active config token nothing is read or sent, and the app needs an update", async () => {
    const { service, slack, appId, calls, tokenStore, sync } =
      await subscribedApp();
    dropEvent(slack, appId);
    await tokenStore.store.invalidate(WORKSPACE, null);
    expect(await service.syncAgentAppManifests()).toEqual({
      checked: 1,
      sent: 0,
      failed: 1,
    });
    expect(calls("apps.manifest.export")).toBe(0);
    expect((await sync())?.error).toBe("config_token_inactive");
  });

  test("without an events address the app needs an update", async () => {
    const ctx = await subscribedApp();
    dropEvent(ctx.slack, ctx.appId);
    const bare = createSlackAppService({
      authorization: createAuthorizationPolicy({ agents: agentAuthority }),
      apps: ctx.apps.store,
      tokens: createSlackConfigTokens({
        store: ctx.tokenStore.store,
        api: ctx.slack.api,
      }),
      api: ctx.slack.api,
      consoleOrigin: ORIGIN,
      eventsPublicUrl: async () => null,
    });
    expect((await bare.syncAgentAppManifests()).failed).toBe(1);
    expect((await ctx.sync())?.error).toBe("events_url_unset");
  });

  test("a refused update is recorded, and a recheck that sends it clears the mark", async () => {
    const { service, slack, appId, sync } = await subscribedApp();
    dropEvent(slack, appId);
    const update = slack.api.updateApp;
    slack.api.updateApp = async () => {
      throw new SlackApiError("apps.manifest.update", "invalid_manifest", true);
    };
    expect((await service.syncAgentAppManifests()).failed).toBe(1);
    expect((await sync())?.error).toBe("slack_refused");
    slack.api.updateApp = update;
    await service.recheckAgentAppEvents(user("owner"), AGENT);
    expect((await sync())?.error).toBeNull();
  });

  test("a lost answer is recorded as no answer", async () => {
    const { service, slack, appId, sync } = await subscribedApp();
    dropEvent(slack, appId);
    slack.api.updateApp = async () => {
      throw new SlackApiError("apps.manifest.update", "timeout", false);
    };
    expect((await service.syncAgentAppManifests()).failed).toBe(1);
    expect((await sync())?.error).toBe("no_answer");
  });

  test("a rate-limited update waits out Retry-After once and is sent", async () => {
    const waits: number[] = [];
    const { service, slack, appId } = await subscribedApp({
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    dropEvent(slack, appId);
    const update = slack.api.updateApp;
    let limited = true;
    slack.api.updateApp = async (...args) => {
      if (limited) {
        limited = false;
        throw new SlackRateLimitedError("apps.manifest.update", 30);
      }
      return update(...args);
    };
    expect((await service.syncAgentAppManifests()).sent).toBe(1);
    expect(waits).toEqual([30_000]);
  });

  test("a Retry-After too long to wait is recorded and not waited for", async () => {
    const waits: number[] = [];
    const { service, slack, appId, sync } = await subscribedApp({
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    dropEvent(slack, appId);
    slack.api.updateApp = async () => {
      throw new SlackRateLimitedError("apps.manifest.update", 600);
    };
    expect((await service.syncAgentAppManifests()).failed).toBe(1);
    expect(waits).toEqual([]);
    expect((await sync())?.error).toBe("slack_refused");
  });

  test("a start soon after another check leaves the app to it", async () => {
    const { service, advance } = await subscribedApp();
    expect((await service.syncAgentAppManifests()).checked).toBe(1);
    expect((await service.syncAgentAppManifests()).checked).toBe(0);
    advance(SLACK_MANIFEST_CHECK_STALE_MS + 1);
    expect((await service.syncAgentAppManifests()).checked).toBe(1);
  });

  test("an API without its secret store checks nothing", async () => {
    const ctx = await setup();
    const off = createSlackAppService({
      authorization: createAuthorizationPolicy({ agents: agentAuthority }),
      apps: null,
      tokens: null,
      api: ctx.slack.api,
      consoleOrigin: ORIGIN,
    });
    expect(await off.syncAgentAppManifests()).toEqual({
      checked: 0,
      sent: 0,
      failed: 0,
    });
  });
});

function user(
  role: WorkspaceRole,
  options: { surface?: "web" | "api"; id?: string } = {},
): Caller {
  return callerFor(
    {
      kind: "user",
      id: options.id ?? crypto.randomUUID(),
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: options.surface ?? "web" },
    crypto.randomUUID(),
  );
}

const agentAuthority: AgentAuthority = {
  agentOf: async (_workspace, resource) =>
    resource.kind === "agent" ? resource.id : null,
  isAdmin: async (_workspace, _agent, userId) => userId === AGENT_ADMIN,
};

async function setup(
  options: {
    consoleOrigin?: string | null;
    eventsPublicUrl?: string;
    logger?: { warn(message: string, fields?: Record<string, unknown>): void };
    activeReleaseWarning?: (
      workspaceId: string,
      agentId: string,
    ) => Promise<SlackAgentWarning | null>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  let clock = new Date("2026-10-23T00:00:00.000Z");
  const secrets = createMemorySecretStore();
  const tokenStore = createMemoryConfigTokenStore(secrets);
  const slack = createFakeSlackConfigApi({ now: () => clock });
  const apps = createMemorySlackAppStore({
    secrets,
    now: () => clock,
    agents: new Map([
      [
        AGENT,
        {
          id: AGENT,
          workspaceId: WORKSPACE,
          name: "Release notes",
          slug: "release-notes",
          role: "Writes the release notes",
          active: true,
        },
      ],
      [
        IDLE_AGENT,
        {
          id: IDLE_AGENT,
          workspaceId: WORKSPACE,
          name: "Draft",
          slug: "draft",
          role: "Not released yet",
          active: false,
        },
      ],
    ]),
  });
  const tokens = createSlackConfigTokens({
    store: tokenStore.store,
    api: slack.api,
    now: () => clock,
  });
  const service = createSlackAppService({
    authorization: createAuthorizationPolicy({ agents: agentAuthority }),
    apps: apps.store,
    tokens,
    api: slack.api,
    consoleOrigin:
      options.consoleOrigin === undefined ? ORIGIN : options.consoleOrigin,
    eventsPublicUrl: async () => options.eventsPublicUrl ?? null,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.activeReleaseWarning
      ? { activeReleaseWarning: options.activeReleaseWarning }
      : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now: () => clock,
  });
  await tokens.register(WORKSPACE, slack.issueRefresh(), {
    principal: user("owner"),
    receiptId: crypto.randomUUID(),
    roles: ["owner", "admin"],
  });
  const creates = () =>
    slack.state.calls.filter((call) => call.method === "apps.manifest.create")
      .length;
  return {
    service,
    slack,
    apps,
    secrets,
    tokenStore,
    creates,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe("Slack app service", () => {
  test("an agent admin creates the app and gets the authorize URL", async () => {
    const { service, slack, secrets } = await setup();
    const out = await service.createAgentApp(
      user("member", { id: AGENT_ADMIN }),
      AGENT,
      { replace_uncertain: false },
    );
    expect(out.created).toBe(true);
    expect(out.slack_app).toMatchObject({
      kind: "agent",
      agent_id: AGENT,
      state: "created",
      app_id: "A0FAKE1",
      client_id: "1000.1",
      redirect_url: `${ORIGIN}/agents/${AGENT}/slack/callback`,
      created_by_token_user: "U0ISSUER",
      secrets: {
        slack_signing_secret: { configured: true },
        slack_client_secret: { configured: true },
        slack_bot_token: { configured: false },
      },
    });
    expect(out).not.toHaveProperty("authorize_url");
    const stored = [...secrets.values.values()].map(({ value }) => value);
    expect(stored).toHaveLength(3);
    for (const value of stored) {
      expect(JSON.stringify(out)).not.toContain(value);
    }
    const manifest = slack.state.apps.get("A0FAKE1")?.manifest as {
      settings: object;
    };
    expect(Object.keys(manifest.settings)).not.toContain("event_subscriptions");
  });

  test("asking again for the same agent returns the same app without a second create", async () => {
    const { service, creates } = await setup();
    const first = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const again = await service.createAgentApp(user("admin"), AGENT, {
      replace_uncertain: false,
    });
    expect(again.created).toBe(false);
    expect(again.slack_app.app_id).toBe(first.slack_app.app_id);
    expect(creates()).toBe(1);
  });

  test("a lost create answer leaves the creating row and a retry asks", async () => {
    const { service, slack, apps, creates, advance } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "timeout", false);
    };
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect([...apps.rows.values()].map((row) => row.state)).toEqual([
      "creating",
    ]);
    const retry = await refusal(
      service.createAgentApp(user("owner"), AGENT, {
        replace_uncertain: false,
      }),
    );
    expect(retry).toMatchObject({
      code: "SLACK_APP_CREATING",
      details: { uncertain: false },
    });
    advance(SLACK_APP_CREATE_STALE_MS + 1);
    expect(
      await refusal(
        service.createAgentApp(user("owner"), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "SLACK_APP_CREATING",
      details: { uncertain: true },
    });
    expect(creates()).toBe(1);
    const replaced = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: true,
    });
    expect(replaced.created).toBe(true);
    expect([...apps.rows.values()].map((row) => row.state)).toEqual([
      "abandoned",
      "created",
    ]);
  });

  test("an answer that cannot be written leaves the row creating, never a second app", async () => {
    const { service, apps, creates } = await setup();
    apps.faults.finishCreate = 3;
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("SLACK_APP_CREATING");
    expect(creates()).toBe(1);
  });

  test("Slack refusing the manifest marks the row failed so a retry can create", async () => {
    const { service, slack, apps } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "invalid_manifest", true);
    };
    expect(
      await refusal(
        service.createAgentApp(user("owner"), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: {
        reason_code: "slack_refused",
        slack_error: "invalid_manifest",
      },
    });
    expect([...apps.rows.values()].map((row) => row.state)).toEqual(["failed"]);
    const out = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(out.created).toBe(true);
  });

  test("a refused manifest logs Slack's error detail, not only the code", async () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const { service, slack } = await setup({
      logger: {
        warn: (message, fields) =>
          lines.push({ message, ...(fields ? { fields } : {}) }),
      },
    });
    slack.state.next.create = async () => {
      throw new SlackApiError(
        "apps.manifest.create",
        "invalid_manifest",
        true,
        {
          httpStatus: 200,
          details: [
            "/features/agent_view/agent_description: The description cannot be empty",
          ],
        },
      );
    };
    await refusal(
      service.createAgentApp(user("owner"), AGENT, {
        replace_uncertain: false,
      }),
    );
    expect(lines).toEqual([
      {
        message: "Slack refused the app manifest",
        fields: {
          method: "apps.manifest.create",
          slack_error: "invalid_manifest",
          http_status: 200,
          details: [
            "/features/agent_view/agent_description: The description cannot be empty",
          ],
        },
      },
    ]);
  });

  test("an agent without an active release is refused before Slack is asked", async () => {
    const { service, creates } = await setup();
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), IDLE_AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("AGENT_NOT_ACTIVE");
    expect(creates()).toBe(0);
  });

  test("a member who is not the agent's admin, and any API caller, are refused", async () => {
    const { service, creates } = await setup();
    expect(
      (
        await refusal(
          service.createAgentApp(user("member"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.createAgentApp(user("owner", { surface: "api" }), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(creates()).toBe(0);
  });

  test("without the console origin no app is made", async () => {
    const { service, creates } = await setup({ consoleOrigin: null });
    expect(
      await refusal(
        service.createAgentApp(user("owner"), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { reason_code: "console_origin_unset" },
    });
    expect(creates()).toBe(0);
  });

  test("a new issuer of the config token is warned about at creation", async () => {
    const { service, slack, tokenStore } = await setup();
    const first = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(first.warnings).toEqual([]);
    slack.state.userId = "U0SECOND";
    const meta = tokenStore.meta.get(WORKSPACE);
    if (meta) meta.accessExpiresAt = new Date(0);
    await service.deleteApp(user("owner"), WORKSPACE, first.slack_app.id);
    const out = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(out.slack_app.created_by_token_user).toBe("U0SECOND");
    expect(out.warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0SECOND",
      },
    ]);
  });

  test("an agent whose release needs a repository is warned about, and still connects", async () => {
    const asked: string[] = [];
    const { service } = await setup({
      activeReleaseWarning: async (workspaceId, agentId) => {
        asked.push(`${workspaceId}/${agentId}`);
        return agentId === AGENT
          ? { code: "repository_required", release_id: "rel-1" }
          : null;
      },
    });
    const warning = {
      code: "repository_required",
      release_id: "rel-1",
    } as const;
    expect((await service.getAgentApp(user("owner"), AGENT)).warnings).toEqual([
      warning,
    ]);
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(made.created).toBe(true);
    expect(made.warnings).toEqual([warning]);
    const again = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(again).toMatchObject({ created: false, warnings: [warning] });
    expect(new Set(asked)).toEqual(new Set([`${WORKSPACE}/${AGENT}`]));
  });

  test("without a release that needs a repository there is no warning", async () => {
    const { service } = await setup({
      activeReleaseWarning: async () => null,
    });
    expect((await service.getAgentApp(user("owner"), AGENT)).warnings).toEqual(
      [],
    );
  });

  test("the memory store lists the link app first by kind, even beside an agent app whose agent is gone", async () => {
    const agents = new Map([
      [
        AGENT,
        {
          id: AGENT,
          workspaceId: WORKSPACE,
          name: "Release notes",
          slug: "release-notes",
          role: "Writes the release notes",
          active: true,
        },
      ],
    ]);
    const apps = createMemorySlackAppStore({
      secrets: createMemorySecretStore(),
      agents,
      workspaces: new Map([[WORKSPACE, "Acme"]]),
    });
    const begin = {
      workspaceId: WORKSPACE,
      actor: null,
      redirectUrl: `${ORIGIN}/callback`,
      staleBefore: new Date(0),
      replaceUncertain: false,
    };
    await apps.store.beginAgentApp({
      ...begin,
      agentId: AGENT,
      newId: crypto.randomUUID(),
    });
    await apps.store.beginLinkApp({ ...begin, newId: crypto.randomUUID() });
    agents.delete(AGENT);

    const made = await apps.store.listMade(WORKSPACE);
    expect(made.map((item) => [item.app.kind, item.agent])).toEqual([
      ["link", null],
      ["agent", null],
    ]);
  });

  test("owners and admins list the apps the console made, from the console only", async () => {
    const { service } = await setup();
    expect(await service.listMadeApps(user("owner"), WORKSPACE)).toEqual({
      items: [],
    });
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const listed = await service.listMadeApps(user("admin"), WORKSPACE);
    expect(listed.items).toEqual([
      {
        slack_app: made.slack_app,
        agent: {
          id: AGENT,
          name: "Release notes",
          slug: "release-notes",
          installed: false,
        },
      },
    ]);
    expect(
      (
        await refusal(
          service.listMadeApps(user("member", { id: AGENT_ADMIN }), WORKSPACE),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.listMadeApps(user("owner", { surface: "api" }), WORKSPACE),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(
      (await refusal(service.listMadeApps(user("owner"), crypto.randomUUID())))
        .code,
    ).toBe("NOT_FOUND");
  });

  test("delete goes to Slack only for the workspace's own app", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(
      (
        await refusal(
          service.deleteApp(user("owner"), WORKSPACE, crypto.randomUUID()),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toEqual([]);
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_app).toMatchObject({
      state: "deleted",
      secrets: { slack_signing_secret: { configured: false } },
    });
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toEqual([{ method: "apps.manifest.delete", appId: "A0FAKE1" }]);
  });

  test("delete settles when Slack answers no_permission for an app that is already gone", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    slack.api.deleteApp = async () => {
      throw new SlackApiError("apps.manifest.delete", "no_permission", true);
    };
    let exports = 0;
    slack.api.exportApp = async () => {
      exports += 1;
      throw new SlackApiError("apps.manifest.export", "app_not_found", true);
    };
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_app.state).toBe("deleted");
    expect(exports).toBe(1);
  });

  test("delete stands on no_permission when another user's token holds the workspace, naming the step", async () => {
    const { service, slack, tokenStore } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    slack.state.userId = "U0SECOND";
    const meta = tokenStore.meta.get(WORKSPACE);
    if (meta) meta.accessExpiresAt = new Date(0);
    let exports = 0;
    slack.api.deleteApp = async () => {
      throw new SlackApiError("apps.manifest.delete", "no_permission", true);
    };
    slack.api.exportApp = async () => {
      exports += 1;
      throw new SlackApiError("apps.manifest.export", "app_not_found", true);
    };
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_app.state).toBe("deleted");
    expect(deleted.slack_cleanup).toMatchObject({
      outcome: "failed",
      failed_steps: ["apps.manifest.delete"],
    });
    expect(exports).toBe(0);
  });

  test("delete stands on no_permission while the app still exists in Slack, and is not tried again", async () => {
    const { service, slack, apps } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    let deletes = 0;
    slack.api.deleteApp = async () => {
      deletes += 1;
      throw new SlackApiError("apps.manifest.delete", "no_permission", true);
    };
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_app.state).toBe("deleted");
    expect(deleted.slack_cleanup?.outcome).toBe("failed");
    expect(deleted.slack_cleanup?.message).toContain("api.slack.com/apps");
    expect([...apps.deleteReceipts.values()]).toEqual([deleted.slack_cleanup]);
    // A second delete finds it deleted and asks Slack nothing.
    const again = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(again.slack_cleanup).toBeNull();
    expect(deletes).toBe(1);
  });

  test.each([
    [
      "answers another code",
      new SlackApiError("apps.manifest.export", "no_permission", true),
    ],
    [
      "gets no answer",
      new SlackApiError("apps.manifest.export", "timeout", false),
    ],
  ])(
    "delete stands on no_permission when export %s",
    async (_name, probeError) => {
      const { service, slack } = await setup();
      const made = await service.createAgentApp(user("owner"), AGENT, {
        replace_uncertain: false,
      });
      slack.api.deleteApp = async () => {
        throw new SlackApiError("apps.manifest.delete", "no_permission", true);
      };
      slack.api.exportApp = async () => {
        throw probeError;
      };
      const deleted = await service.deleteApp(
        user("owner"),
        WORKSPACE,
        made.slack_app.id,
      );
      expect(deleted.slack_app.state).toBe("deleted");
      expect(deleted.slack_cleanup?.failed_steps).toEqual([
        "apps.manifest.delete",
      ]);
    },
  );

  test("delete closes Werft's side before Slack, revokes the bot token once and records how it went", async () => {
    const { service, slack, apps, secrets } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    secrets.write(
      {
        workspaceId: WORKSPACE,
        owner: { kind: "slack_app", id: made.slack_app.id },
        purpose: "slack_bot_token",
      },
      `bot-${crypto.randomUUID()}`,
    );
    const seen: string[] = [];
    slack.api.revokeBotToken = async () => {
      seen.push(
        `auth.revoke:${(await service.getAgentApp(user("owner"), AGENT)).slack_app === null ? "closed" : "open"}`,
      );
      throw new SlackApiError("auth.revoke", "timeout", false);
    };
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(seen).toEqual(["auth.revoke:closed"]);
    expect(deleted.slack_app.state).toBe("deleted");
    expect(deleted.slack_cleanup).toEqual({
      outcome: "failed",
      failed_steps: ["auth.revoke"],
      message: expect.stringContaining("api.slack.com/apps"),
    });
    expect([...apps.deleteReceipts.values()]).toEqual([deleted.slack_cleanup]);
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toHaveLength(1);
  });

  test("a bot token Slack already revoked counts as done", async () => {
    const { service, slack, secrets } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    secrets.write(
      {
        workspaceId: WORKSPACE,
        owner: { kind: "slack_app", id: made.slack_app.id },
        purpose: "slack_bot_token",
      },
      `bot-${crypto.randomUUID()}`,
    );
    slack.state.next.revoke = async () => {
      throw new SlackApiError("auth.revoke", "token_revoked", true);
    };
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_cleanup).toEqual({
      outcome: "done",
      failed_steps: [],
      message: null,
    });
  });

  test("a manifest update reads the app id from the workspace's own rows", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const input = { name: "Renamed", botName: "renamed", description: "x" };
    expect(
      (
        await refusal(
          service.updateAgentAppManifest(WORKSPACE, crypto.randomUUID(), input),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await refusal(
          service.updateAgentAppManifest(
            "019a0000-0000-7000-8000-0000000000f9",
            made.slack_app.id,
            input,
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
    await service.updateAgentAppManifest(WORKSPACE, made.slack_app.id, input);
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.update"),
    ).toEqual([{ method: "apps.manifest.update", appId: "A0FAKE1" }]);
  });
});
