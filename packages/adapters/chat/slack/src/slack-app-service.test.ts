import { describe, expect, test } from "bun:test";
import {
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
} from "./slack-app-service.ts";
import { SLACK_HTTP_TIMEOUT_MS, SlackApiError } from "./slack-config-api.ts";
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

test("a reinstall keeps a verified URL verified and a changed URL pending again", async () => {
  const { service, apps } = await setup();
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
    eventsPublicUrl: options.eventsPublicUrl ?? null,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.activeReleaseWarning
      ? { activeReleaseWarning: options.activeReleaseWarning }
      : {}),
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

  test("an agent whose profile needs a repository is warned about, and still connects", async () => {
    const asked: string[] = [];
    const { service } = await setup({
      activeReleaseWarning: async (workspaceId, agentId) => {
        asked.push(`${workspaceId}/${agentId}`);
        return agentId === AGENT
          ? { code: "repository_required", profile_id: "claude-coding-local" }
          : null;
      },
    });
    const warning = {
      code: "repository_required",
      profile_id: "claude-coding-local",
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

  test("without a repository-only profile there is no warning", async () => {
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

  test("delete stays refused on no_permission when another user's token holds the workspace", async () => {
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
    await refusal(
      service.deleteApp(user("owner"), WORKSPACE, made.slack_app.id),
    );
    expect(exports).toBe(0);
  });

  test("delete stays refused on no_permission while the app still exists in Slack", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    slack.api.deleteApp = async () => {
      throw new SlackApiError("apps.manifest.delete", "no_permission", true);
    };
    const error = await refusal(
      service.deleteApp(user("owner"), WORKSPACE, made.slack_app.id),
    );
    expect(error.code).not.toBe("NOT_FOUND");
    expect(
      (await service.getAgentApp(user("owner"), AGENT)).slack_app?.state,
    ).not.toBe("deleted");
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
    "delete stays refused on no_permission when export %s",
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
      await refusal(
        service.deleteApp(user("owner"), WORKSPACE, made.slack_app.id),
      );
      expect(
        (await service.getAgentApp(user("owner"), AGENT)).slack_app?.state,
      ).not.toBe("deleted");
    },
  );

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
