import { afterAll, describe, expect, test } from "bun:test";
import {
  createSlackAppService,
  createSlackConfigTokens,
  createSlackSecretService,
  SlackApiError,
} from "@werft-ai/chat-slack";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
} from "@werft-ai/chat-slack/testing/slack";
import {
  apiErrorResponseSchema,
  BOT_SCOPES,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createSlackAppResponseSchema,
  deleteSlackAppResponseSchema,
  getSlackAppResponseSchema,
  listWorkspaceSlackAppsResponseSchema,
  putSlackSecretResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type AgentAuthority,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSlackAppRoutes } from "./slack-apps.ts";

const createApiApp = recordRouteErrors("routes/surface/slack-apps.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const IDLE_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const LOST_AGENT = "019a0000-0000-7000-8000-0000000000c3";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000c4";
const NEXT_AGENT = "019a0000-0000-7000-8000-0000000000c5";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000d1";
const ORIGIN = "https://console.example.ts.net";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(
  role: MembershipRole,
  options: { workspaceId?: string; userId?: string } = {},
): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: options.userId ?? crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: options.workspaceId ?? WORKSPACE,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY.plaintext)).equals(Buffer.from(candidate)))
      return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal" as const,
      createdByUserId: crypto.randomUUID(),
      creatorRole: "owner" as const,
      scopes: [
        "sessions:read" as const,
        "sessions:write" as const,
        "sessions:control" as const,
      ],
    };
  },
};

const agentAuthority: AgentAuthority = {
  agentOf: async (_workspace, resource) =>
    resource.kind === "agent" ? resource.id : null,
  isAdmin: async (_workspace, _agent, userId) => userId === AGENT_ADMIN,
};

const secrets = createMemorySecretStore();
const tokenStore = createMemoryConfigTokenStore(secrets);
const slack = createFakeSlackConfigApi();
const agent = (id: string, workspaceId: string, active: boolean) =>
  [
    id,
    {
      id,
      workspaceId,
      name: "Release notes",
      slug: "release-notes",
      role: "Writes the release notes",
      active,
    },
  ] as const;
const apps = createMemorySlackAppStore({
  secrets,
  agents: new Map([
    agent(AGENT, WORKSPACE, true),
    agent(IDLE_AGENT, WORKSPACE, false),
    agent(LOST_AGENT, WORKSPACE, true),
    agent(OTHER_AGENT, OTHER_WORKSPACE, true),
    agent(NEXT_AGENT, WORKSPACE, true),
  ]),
});
const issuedAppSecrets: string[] = [];
const createApp = slack.api.createApp;
slack.api.createApp = async (token, manifest) => {
  const created = await createApp(token, manifest);
  issuedAppSecrets.push(created.signingSecret, created.clientSecret);
  return created;
};
const LIVE = new Set(["creating", "created", "deleting"]);
const kindLookups: string[] = [];

const logs = new MemoryLogSink();
const responses: string[] = [];

function appWith(enabled: boolean) {
  const authorization = createAuthorizationPolicy({ agents: agentAuthority });
  const tokens = enabled
    ? createSlackConfigTokens({ store: tokenStore.store, api: slack.api })
    : null;
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerSlackAppRoutes(router, {
        apps: createSlackAppService({
          authorization,
          apps: enabled ? apps.store : null,
          tokens,
          api: slack.api,
          consoleOrigin: ORIGIN,
          eventsPublicUrl: async () => "https://events.example.test",
        }),
        secrets: createSlackSecretService({
          authorization,
          store: enabled ? secrets.store : null,
          tokens,
          urls: async () => ({ redirect_url: null, events_url_template: null }),
          appKind: async (workspaceId, slackAppId) => {
            kindLookups.push(slackAppId);
            const row = apps.rows.get(slackAppId);
            return row?.workspaceId === workspaceId && LIVE.has(row.state)
              ? row.kind
              : null;
          },
        }),
        logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
      }),
  });
  return async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      cookie?: string;
      key?: boolean;
      csrf?: boolean;
      body?: unknown;
    } = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
        ...(options.csrf === false
          ? {}
          : { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }),
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : {
            body:
              typeof options.body === "string"
                ? options.body
                : JSON.stringify(options.body),
          }),
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

const call = appWith(true);
const appPath = (agentId: string) => `/v1/agents/${agentId}/slack/app`;
const deletePath = (slackAppId: string, workspaceId = WORKSPACE) =>
  `/v1/workspaces/${workspaceId}/slack/apps/${slackAppId}`;
const secretPath = (slackAppId: string, purpose: string) =>
  `${deletePath(slackAppId)}/secrets/${purpose}`;
const create = (agentId: string, cookie: string, body: unknown = {}) =>
  call("POST", appPath(agentId), { cookie, body });

function code(json: unknown) {
  return apiErrorResponseSchema.parse(json).error;
}

async function pasteConfigToken() {
  await createSlackConfigTokens({
    store: tokenStore.store,
    api: slack.api,
  }).register(WORKSPACE, slack.issueRefresh(), {
    principal: { actor: { userId: crypto.randomUUID() } } as never,
    receiptId: crypto.randomUUID(),
    roles: [],
  });
}

describe("the agent Slack app API", () => {
  test("settings persist before app creation and require an agent manager", async () => {
    const path = `${appPath(IDLE_AGENT)}/settings`;
    const owner = cookieFor("owner");
    expect((await call("GET", path, { cookie: owner })).json).toEqual({
      mention_only: true,
    });
    expect(
      (
        await call("PUT", path, {
          cookie: owner,
          body: { mention_only: false },
        })
      ).status,
    ).toBe(200);
    expect((await call("GET", path, { cookie: owner })).json).toEqual({
      mention_only: false,
    });
    // The per-channel modes and the old field are gone.
    for (const body of [
      { mention_only: "false" },
      { default_mode: "mention" },
      { mention_only: true, default_mode: "mention" },
    ]) {
      expect((await call("PUT", path, { cookie: owner, body })).status).toBe(
        400,
      );
    }
    expect(
      (
        await call("PUT", path, {
          cookie: owner,
          body: { mention_only: true, pad: "a".repeat(70_000) },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call("PUT", path, {
          cookie: cookieFor("member"),
          body: { mention_only: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("GET", `${appPath(OTHER_AGENT)}/settings`, { cookie: owner }))
        .status,
    ).toBe(404);
    expect((await call("GET", path, { key: true })).status).toBe(403);
    for (const suffix of ["/manifest", "/settings"]) {
      expect(
        (
          await call("GET", `${appPath(OTHER_AGENT)}${suffix}`, {
            cookie: owner,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await call("GET", `${appPath(AGENT)}${suffix}`, {
            cookie: cookieFor("member"),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await appWith(false)("GET", `${appPath(AGENT)}${suffix}`, {
            cookie: owner,
          })
        ).status,
      ).toBe(503);
    }
    expect(
      (
        await appWith(false)("PUT", path, {
          cookie: owner,
          body: { mention_only: true },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await call("PUT", `${appPath(OTHER_AGENT)}/settings`, {
          cookie: owner,
          body: { mention_only: true },
        })
      ).status,
    ).toBe(404);
  });
  test("without a config token, creation answers 409 and records a failed attempt", async () => {
    const response = await create(AGENT, cookieFor("owner"));
    expect(response.status).toBe(409);
    expect(code(response.json)).toMatchObject({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "not_set" },
    });
    expect(slack.state.calls).toEqual([]);
    expect([...apps.rows.values()].map((row) => row.state)).toEqual(["failed"]);
  });

  test("the agent's admin creates its app once, and no install URL comes with it", async () => {
    await pasteConfigToken();
    const admin = cookieFor("member", { userId: AGENT_ADMIN });
    const first = await create(AGENT, admin);
    expect(first.status).toBe(200);
    const created = createSlackAppResponseSchema.parse(first.json);
    expect(created).toMatchObject({
      created: true,
      warnings: [],
      slack_app: {
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
      },
    });
    expect(first.json).not.toHaveProperty("authorize_url");
    expect(
      (slack.state.apps.get("A0FAKE1")?.manifest as { oauth_config: object })
        .oauth_config,
    ).toEqual({
      redirect_urls: [`${ORIGIN}/agents/${AGENT}/slack/callback`],
      scopes: { bot: [...BOT_SCOPES] },
    });

    const again = await create(AGENT, cookieFor("owner"));
    expect(again.json).toMatchObject({
      created: false,
      slack_app: { id: created.slack_app.id, app_id: "A0FAKE1" },
    });
    expect(again.json).not.toHaveProperty("authorize_url");
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.create"),
    ).toHaveLength(1);

    const read = await call("GET", appPath(AGENT), { cookie: admin });
    expect(getSlackAppResponseSchema.parse(read.json)).toMatchObject({
      slack_app: { id: created.slack_app.id },
    });
    expect(read.json).not.toHaveProperty("authorize_url");
    expect(read.json).toMatchObject({
      event_url: `https://events.example.test/v1/slack/events/${AGENT}`,
      events: { state: "pending", checked_at: null },
      config_token: "active",
    });
    const manifest = await call("GET", `${appPath(AGENT)}/manifest`, {
      cookie: admin,
    });
    expect(manifest.status).toBe(200);
    expect(manifest.json.manifest_yaml).toContain(
      `https://events.example.test/v1/slack/events/${AGENT}`,
    );
    expect(manifest.json.manifest_yaml).not.toContain("client_secret");
    expect(manifest.json.manifest_yaml).not.toContain("signing_secret");
    expect(
      (await call("GET", appPath(IDLE_AGENT), { cookie: admin })).json,
    ).toEqual({
      slack_app: null,
      event_url: `https://events.example.test/v1/slack/events/${IDLE_AGENT}`,
      events: { state: "pending", checked_at: null, url: null },
      warnings: [],
      config_token: "active",
    });

    const recheck = await call("POST", `${appPath(AGENT)}/events/recheck`, {
      cookie: admin,
    });
    expect(recheck.status).toBe(200);
    expect(recheck.json.events).toMatchObject({
      state: "pending",
      url: `https://events.example.test/v1/slack/events/${AGENT}`,
    });
    const none = await call("POST", `${appPath(IDLE_AGENT)}/events/recheck`, {
      cookie: admin,
    });
    expect(none.status).toBe(404);
    expect(code(none.json).code).toBe("NOT_FOUND");

    const updateApp = slack.api.updateApp;
    slack.api.updateApp = async () => {
      throw new SlackApiError("apps.manifest.update", "token_expired", true);
    };
    const expired = await call("POST", `${appPath(AGENT)}/events/recheck`, {
      cookie: admin,
    });
    slack.api.updateApp = updateApp;
    expect(expired.status).toBe(409);
    expect(code(expired.json)).toMatchObject({
      code: "CONFIG_TOKEN_INVALID",
      details: { reason_code: "rejected" },
    });
  });

  test("a member who is not the agent's admin, an API key, or a write without CSRF is refused", async () => {
    const before = slack.state.calls.length;
    for (const response of [
      await create(LOST_AGENT, cookieFor("member")),
      await call("GET", appPath(AGENT), { cookie: cookieFor("member") }),
      await call("POST", appPath(LOST_AGENT), { key: true, body: {} }),
      await call("POST", appPath(LOST_AGENT), {
        cookie: cookieFor("owner"),
        csrf: false,
        body: {},
      }),
      await call("POST", `${appPath(AGENT)}/events/recheck`, {
        cookie: cookieFor("member"),
      }),
      await call("POST", `${appPath(AGENT)}/events/recheck`, { key: true }),
      await call("POST", `${appPath(AGENT)}/events/recheck`, {
        cookie: cookieFor("owner"),
        csrf: false,
      }),
    ]) {
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    expect(slack.state.calls.length).toBe(before);
  });

  test("an agent with no active release, unknown or elsewhere gets no app", async () => {
    const owner = cookieFor("owner");
    const idle = await create(IDLE_AGENT, owner);
    expect(idle.status).toBe(409);
    expect(code(idle.json).code).toBe("AGENT_NOT_ACTIVE");
    expect((await create(OTHER_AGENT, owner)).status).toBe(404);
    expect(
      (await call("GET", appPath("not-a-uuid"), { cookie: owner })).status,
    ).toBe(404);
    expect(
      (await create(LOST_AGENT, owner, `{"pad":"${"a".repeat(70_000)}"}`))
        .status,
    ).toBe(413);
    expect((await create(crypto.randomUUID(), owner)).status).toBe(404);
    expect((await create("not-a-uuid", owner)).status).toBe(404);
    expect(
      (await create(LOST_AGENT, owner, { replace_uncertain: "yes" })).status,
    ).toBe(400);
  });

  test("a lost create answer leaves the row creating; a retry is told so", async () => {
    const owner = cookieFor("owner");
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "timeout", false);
    };
    const lost = await create(LOST_AGENT, owner);
    expect(lost.status).toBe(503);
    const retry = await create(LOST_AGENT, owner);
    expect(retry.status).toBe(409);
    expect(code(retry.json)).toMatchObject({
      code: "SLACK_APP_CREATING",
      details: { uncertain: false },
    });
    const row = [...apps.rows.values()].find(
      (candidate) => candidate.agentId === LOST_AGENT,
    );
    expect(row?.state).toBe("creating");
    const deleting = await call("DELETE", deletePath(row?.id ?? ""), {
      cookie: owner,
    });
    expect(deleting.status).toBe(409);
    expect(code(deleting.json).code).toBe("SLACK_APP_CREATING");
  });

  test("a config token of another Slack user is warned about on the next create", async () => {
    slack.state.userId = "U0OTHER";
    await pasteConfigToken();
    const response = await create(NEXT_AGENT, cookieFor("owner"));
    expect(response.status).toBe(200);
    expect(response.json.warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0OTHER",
      },
    ]);
    // The app made before the paste is one the new issuer may not manage.
    const older = await call("GET", appPath(AGENT), {
      cookie: cookieFor("owner"),
    });
    expect(getSlackAppResponseSchema.parse(older.json).warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0OTHER",
      },
    ]);
    const newer = await call("GET", appPath(NEXT_AGENT), {
      cookie: cookieFor("owner"),
    });
    expect(getSlackAppResponseSchema.parse(newer.json).warnings).toEqual([]);
    slack.state.userId = "U0ISSUER";
  });
});

describe("deleting a Slack app", () => {
  test("only an app of this workspace is named", async () => {
    const owner = cookieFor("owner");
    const created = [...apps.rows.values()].find(
      (row) => row.agentId === AGENT && row.state === "created",
    );
    if (!created) throw new Error("no app");
    expect(
      (
        await call("DELETE", deletePath(created.id, OTHER_WORKSPACE), {
          cookie: cookieFor("owner", { workspaceId: OTHER_WORKSPACE }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", deletePath(crypto.randomUUID()), { cookie: owner }))
        .status,
    ).toBe(404);
    expect(
      (await call("DELETE", deletePath("not-a-uuid"), { cookie: owner }))
        .status,
    ).toBe(404);
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toEqual([]);
  });

  test("owners and admins list the workspace's made apps from the console", async () => {
    const listPath = (workspaceId = WORKSPACE) =>
      `/v1/workspaces/${workspaceId}/slack/apps`;
    const listed = await call("GET", listPath(), {
      cookie: cookieFor("admin"),
    });
    expect(listed.status).toBe(200);
    expect(
      listWorkspaceSlackAppsResponseSchema
        .parse(listed.json)
        .items.map((item) => [item.slack_app.agent_id, item.agent?.slug]),
    ).toContainEqual([AGENT, "release-notes"]);
    expect(
      (
        await call("GET", listPath(), {
          cookie: cookieFor("member", { userId: AGENT_ADMIN }),
        })
      ).status,
    ).toBe(403);
    expect((await call("GET", listPath(), { key: true })).status).toBe(403);
    expect(
      (
        await call("GET", listPath(OTHER_WORKSPACE), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(404);
    expect((await call("GET", listPath())).status).toBe(401);
  });

  test("the agent's admin deletes it in Slack; its secrets go with it", async () => {
    const created = [...apps.rows.values()].find(
      (row) => row.agentId === AGENT && row.state === "created",
    );
    if (!created) throw new Error("no app");
    const response = await call("DELETE", deletePath(created.id), {
      cookie: cookieFor("member", { userId: AGENT_ADMIN }),
    });
    expect([response.status, response.json?.error?.code]).toEqual([
      200,
      undefined,
    ]);
    expect(deleteSlackAppResponseSchema.parse(response.json)).toMatchObject({
      slack_app: {
        state: "deleted",
        secrets: {
          slack_signing_secret: { configured: false },
          slack_client_secret: { configured: false },
        },
      },
    });
    expect(slack.state.apps.has("A0FAKE1")).toBe(false);
  });
});

describe("a Slack app's secrets", () => {
  const manualId = crypto.randomUUID();
  const autoId = () =>
    [...apps.rows.values()].find(
      (row) => row.kind === "agent" && row.state === "created",
    )?.id ?? "";

  test("a manual app takes a value from an owner; an app the platform made does not", async () => {
    const now = new Date();
    apps.seed({
      id: manualId,
      workspaceId: WORKSPACE,
      kind: "manual",
      agentId: null,
      state: "created",
      appId: "A0MANUAL",
      clientId: "2000.1",
      redirectUrl: `${ORIGIN}/manual`,
      createdByTokenUser: null,
      createdAt: now,
      updatedAt: now,
    });
    const owner = cookieFor("owner");
    const value = `manual-${crypto.randomUUID()}`;
    const set = await call(
      "PUT",
      secretPath(manualId, "slack_signing_secret"),
      {
        cookie: owner,
        body: { value },
      },
    );
    expect(set.status).toBe(200);
    expect(putSlackSecretResponseSchema.parse(set.json)).toMatchObject({
      configured: true,
      last4: value.slice(-4),
    });

    const refused = await call(
      "PUT",
      secretPath(autoId(), "slack_signing_secret"),
      { cookie: owner, body: { value } },
    );
    expect(refused.status).toBe(403);
    expect(code(refused.json)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "server_managed_secret" },
    });
    expect(
      (
        await call("PUT", secretPath(crypto.randomUUID(), "slack_bot_token"), {
          cookie: owner,
          body: { value },
        })
      ).status,
    ).toBe(404);
  });

  test("a bad purpose or a malformed app id is 400 before any lookup", async () => {
    const owner = cookieFor("owner");
    kindLookups.length = 0;
    for (const path of [
      secretPath(manualId, "slack_config_token"),
      secretPath(manualId, "anything"),
      secretPath("not-a-uuid", "slack_signing_secret"),
    ]) {
      const response = await call("PUT", path, {
        cookie: owner,
        body: { value: `v-${crypto.randomUUID()}` },
      });
      expect(response.status).toBe(400);
    }
    expect(kindLookups).toEqual([]);
    const huge = await call(
      "PUT",
      secretPath(manualId, "slack_signing_secret"),
      { cookie: owner, body: { value: "a".repeat(70_000) } },
    );
    expect(huge.status).toBe(413);
  });

  test("a member is refused", async () => {
    const response = await call(
      "PUT",
      secretPath(manualId, "slack_client_secret"),
      { cookie: cookieFor("member"), body: { value: "v-1234567890" } },
    );
    expect(response.status).toBe(403);
  });
});

test("without a master key every route answers 503", async () => {
  const off = appWith(false);
  const owner = cookieFor("owner");
  for (const response of [
    await off("GET", appPath(AGENT), { cookie: owner }),
    await off("POST", appPath(AGENT), { cookie: owner, body: {} }),
    await off("GET", `/v1/workspaces/${WORKSPACE}/slack/apps`, {
      cookie: owner,
    }),
    await off("DELETE", deletePath(crypto.randomUUID()), { cookie: owner }),
    await off("PUT", secretPath(crypto.randomUUID(), "slack_bot_token"), {
      cookie: owner,
      body: { value: "v-1234567890" },
    }),
  ]) {
    expect(response.status).toBe(503);
  }
});

afterAll(() => {
  const seen = [...responses, ...logs.records.map((r) => JSON.stringify(r))];
  const values = [
    ...issuedAppSecrets,
    ...[...secrets.values.values()].flatMap(({ value }) => value.split("\n")),
  ];
  expect(issuedAppSecrets.length).toBeGreaterThan(0);
  for (const text of seen) {
    for (const value of values) {
      expect(text).not.toContain(value);
    }
  }
  expect(logs.records.some((r) => r.message === "Slack app created")).toBe(
    true,
  );
});
