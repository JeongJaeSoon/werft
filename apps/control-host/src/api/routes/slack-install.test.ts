import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  BOT_SCOPES,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  completeSlackInstallResponseSchema,
  startSlackInstallResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type AgentAuthority,
  createAuthorizationPolicy,
  createSlackAppService,
  createSlackConfigTokens,
  createSlackInstallService,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  SlackApiError,
  type SlackInstalled,
} from "@werft-ai/platform";
import {
  createFakeSlackConfigApi,
  createMemoryAgentIdentityStore,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
  createMemorySlackInstallStore,
} from "@werft-ai/platform/testing/slack";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackInstallRoutes } from "./slack-install.ts";

const createApiApp = recordRouteErrors("routes/slack-install.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const SECOND_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const REJECTED_AGENT = "019a0000-0000-7000-8000-0000000000c3";
const CONFLICT_AGENT = "019a0000-0000-7000-8000-0000000000c4";
const NO_APP_AGENT = "019a0000-0000-7000-8000-0000000000c5";
const CREATING_AGENT = "019a0000-0000-7000-8000-0000000000c6";
const DELETING_AGENT = "019a0000-0000-7000-8000-0000000000c7";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000c8";
const UNKNOWN_AGENT = "019a0000-0000-7000-8000-0000000000c9";
const GONE_AGENT = "019a0000-0000-7000-8000-0000000000ca";
const OTHERS_AGENT = "019a0000-0000-7000-8000-0000000000cb";
const OWNER = "019a0000-0000-7000-8000-0000000000d1";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000d2";
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
      createdByUserId: OWNER,
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
    resource.kind === "agent" && resource.id !== UNKNOWN_AGENT
      ? resource.id
      : null,
  isAdmin: async (_workspace, _agent, userId) => userId === AGENT_ADMIN,
};

const secrets = createMemorySecretStore();
const tokenStore = createMemoryConfigTokenStore(secrets);
const slack = createFakeSlackConfigApi();
const agentRow = (id: string, workspaceId = WORKSPACE) =>
  [
    id,
    {
      id,
      workspaceId,
      name: "Release notes",
      slug: "release-notes",
      role: "Writes the release notes",
      active: true,
    },
  ] as const;
const apps = createMemorySlackAppStore({
  secrets,
  agents: new Map([
    agentRow(AGENT),
    agentRow(SECOND_AGENT),
    agentRow(REJECTED_AGENT),
    agentRow(CONFLICT_AGENT),
  ]),
});
const installs = createMemorySlackInstallStore();
const identities = createMemoryAgentIdentityStore(installs.installations);
const finalized: SlackInstalled[] = [];
const finalizeFaults = { next: 0 };
let clock = new Date("2026-10-24T09:00:00.000Z");

const logs = new MemoryLogSink();
const responses: string[] = [];
/** Every state, code and bot token the tests saw, for the leak scan. */
const handled: string[] = [];

function appWith(
  enabled: boolean,
  withTokens: (
    tokens: ReturnType<typeof createSlackConfigTokens>,
  ) => ReturnType<typeof createSlackConfigTokens> = (tokens) => tokens,
) {
  const authorization = createAuthorizationPolicy({ agents: agentAuthority });
  const logger = new StructuredLogger({ sinks: [logs], level: "debug" });
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger,
    registerRoutes: (router) =>
      registerSlackInstallRoutes(router, {
        service: createSlackInstallService({
          authorization,
          apps: enabled ? apps.store : null,
          states: enabled ? installs.store : null,
          secrets: enabled ? secrets.store : null,
          tokens: withTokens(
            createSlackConfigTokens({
              store: tokenStore.store,
              api: slack.api,
            }),
          ),
          identities: identities.store,
          api: slack.api,
          finalize: async (installed) => {
            finalized.push(installed);
            if (finalizeFaults.next > 0) {
              finalizeFaults.next -= 1;
              throw new Error("finalize failed");
            }
            return { finalized: true, warnings: [] };
          },
          now: () => clock,
        }),
        logger,
      }),
  });
  return async (
    path: string,
    options: {
      cookie?: string;
      key?: boolean;
      csrf?: boolean;
      body?: unknown;
    } = {},
  ) => {
    const response = await app.request(path, {
      method: "POST",
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
    // A start answer carries its state by design.
    if (path === COMPLETE) responses.push(text);
    return {
      status: response.status,
      json: text ? JSON.parse(text) : null,
      referrerPolicy: response.headers.get("referrer-policy"),
    };
  };
}

const call = appWith(true);
const owner = () => cookieFor("owner", { userId: OWNER });
const admin = () => cookieFor("member", { userId: AGENT_ADMIN });
const startPath = (agentId: string) =>
  `/v1/agents/${agentId}/slack/install/start`;
const COMPLETE = "/v1/slack/install/complete";

function code(json: unknown) {
  return apiErrorResponseSchema.parse(json).error;
}

async function start(agentId: string, cookie: string) {
  const response = await call(startPath(agentId), { cookie });
  expect([response.status, response.json?.error?.code]).toEqual([
    200,
    undefined,
  ]);
  const { authorize_url } = startSlackInstallResponseSchema.parse(
    response.json,
  );
  return authorize_url;
}

/** The admin approves in Slack; the redirect carries back this. */
function approve(authorizeUrl: string) {
  const answer = slack.authorize(authorizeUrl);
  handled.push(answer.code, answer.state);
  return answer;
}

function complete(
  cookie: string,
  body: { agent_id: string; state: string; code?: string; error?: string },
) {
  return call(COMPLETE, { cookie, body });
}

const botTokenSlots = () =>
  [...secrets.values.keys()].filter((key) => key.endsWith("|slack_bot_token"));
const appOf = (agentId: string) => {
  const row = [...apps.rows.values()].find(
    (candidate) =>
      candidate.agentId === agentId && candidate.state === "created",
  );
  if (!row) throw new Error(`no app for ${agentId}`);
  return row;
};

const setup = (async () => {
  await createSlackConfigTokens({
    store: tokenStore.store,
    api: slack.api,
  }).register(WORKSPACE, slack.issueRefresh(), {
    principal: { actor: { userId: OWNER } } as never,
    receiptId: crypto.randomUUID(),
    roles: [],
  });
  const service = createSlackAppService({
    authorization: createAuthorizationPolicy({}),
    apps: apps.store,
    tokens: createSlackConfigTokens({
      store: tokenStore.store,
      api: slack.api,
    }),
    api: slack.api,
    consoleOrigin: ORIGIN,
  });
  for (const agentId of [AGENT, SECOND_AGENT, REJECTED_AGENT, CONFLICT_AGENT]) {
    await service.createAgentAppAsOperator(WORKSPACE, agentId, {
      replace_uncertain: false,
    });
  }
  const seed = (
    agentId: string,
    state: "creating" | "created" | "deleting",
    workspaceId = WORKSPACE,
  ) =>
    apps.seed({
      id: crypto.randomUUID(),
      workspaceId,
      kind: "agent",
      agentId,
      state,
      appId: state === "creating" ? null : `A0SEED${agentId.slice(-2)}`,
      clientId: state === "creating" ? null : `9000.${agentId.slice(-2)}`,
      redirectUrl: `${ORIGIN}/agents/${agentId}/slack/callback`,
      createdByTokenUser: null,
      createdAt: clock,
      updatedAt: clock,
    });
  seed(CREATING_AGENT, "creating");
  seed(DELETING_AGENT, "deleting");
  seed(OTHER_AGENT, "created", OTHER_WORKSPACE);
  // Made by this token's user, in a Slack that no longer has it.
  seed(GONE_AGENT, "created");
  appOf(GONE_AGENT).createdByTokenUser = "U0ISSUER";
  // Made by another Slack user, as a mock Slack's app is.
  seed(OTHERS_AGENT, "created");
  appOf(OTHERS_AGENT).createdByTokenUser = "U0MOCK";
})();

describe("starting an install", () => {
  test("each call makes a new single-use state bound into Slack's consent URL", async () => {
    await setup;
    const first = new URL(await start(AGENT, owner()));
    const second = new URL(await start(AGENT, owner()));
    const app = appOf(AGENT);
    expect(`${first.origin}${first.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(Object.fromEntries(first.searchParams)).toEqual({
      client_id: app.clientId ?? "",
      scope: BOT_SCOPES.join(","),
      redirect_uri: `${ORIGIN}/agents/${AGENT}/slack/callback`,
      state: first.searchParams.get("state") ?? "",
    });
    const states = [first, second].map(
      (url) => url.searchParams.get("state") ?? "",
    );
    handled.push(...states);
    expect(states[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(states[0]).not.toBe(states[1]);
    // Only hashes are kept.
    expect([...installs.states.keys()].join()).not.toContain(states[0] ?? "");
    expect([...installs.states.values()].slice(-2)).toEqual(
      [0, 1].map(() => ({
        workspaceId: WORKSPACE,
        agentId: AGENT,
        slackAppId: app.id,
        actorUserId: OWNER,
        teamId: "T0FAKE",
        redirectUrl: `${ORIGIN}/agents/${AGENT}/slack/callback`,
        expiresAt: new Date(clock.getTime() + 600_000),
      })),
    );
  });

  test("a member, an API key or a write without CSRF is refused", async () => {
    await setup;
    for (const response of [
      await call(startPath(AGENT), { cookie: cookieFor("member") }),
      await call(startPath(AGENT), { key: true }),
      await call(startPath(AGENT), { cookie: owner(), csrf: false }),
    ]) {
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
  });

  test("only an agent whose app is created gets a link", async () => {
    await setup;
    const noApp = await call(startPath(NO_APP_AGENT), { cookie: owner() });
    expect(noApp.status).toBe(404);
    expect(
      (await call(startPath(UNKNOWN_AGENT), { cookie: owner() })).status,
    ).toBe(404);
    const creating = await call(startPath(CREATING_AGENT), { cookie: owner() });
    expect([creating.status, code(creating.json).code]).toEqual([
      409,
      "SLACK_APP_CREATING",
    ]);
    const deleting = await call(startPath(DELETING_AGENT), { cookie: owner() });
    expect([deleting.status, code(deleting.json).code]).toEqual([
      409,
      "REVISION_CONFLICT",
    ]);
    const noToken = await call(startPath(OTHER_AGENT), {
      cookie: cookieFor("owner", { workspaceId: OTHER_WORKSPACE }),
    });
    expect([noToken.status, code(noToken.json)]).toMatchObject([
      409,
      { code: "CONFIG_TOKEN_INVALID", details: { reason_code: "not_set" } },
    ]);
    const off = await appWith(false)(startPath(AGENT), { cookie: owner() });
    expect(off.status).toBe(503);
  });

  test("an app Slack no longer has is refused before a link is made", async () => {
    await setup;
    const before = installs.states.size;
    const gone = await call(startPath(GONE_AGENT), { cookie: owner() });
    expect([gone.status, code(gone.json)]).toMatchObject([
      409,
      {
        code: "SLACK_APP_GONE",
        details: { slack_app_id: appOf(GONE_AGENT).id, app_id: "A0SEEDca" },
      },
    ]);
    expect(installs.states.size).toBe(before);
    expect(slack.state.calls.at(-1)).toEqual({
      method: "apps.manifest.export",
      appId: "A0SEEDca",
    });
    for (const gone of ["invalid_app_id", "app_deleted"]) {
      slack.state.next.export = async () => {
        throw new SlackApiError("apps.manifest.export", gone, true);
      };
      const again = await call(startPath(GONE_AGENT), { cookie: owner() });
      expect([again.status, code(again.json).code]).toEqual([
        409,
        "SLACK_APP_GONE",
      ]);
    }
  });

  test("an app another Slack user made is not checked with this token", async () => {
    await setup;
    const before = slack.state.calls.length;
    const url = new URL(await start(OTHERS_AGENT, owner()));
    handled.push(url.searchParams.get("state") ?? "");
    expect(url.searchParams.get("client_id")).toBe("9000.cb");
    expect(slack.state.calls.length).toBe(before);
  });

  test("a token that changed hands after it was described is not used for the check", async () => {
    await setup;
    const swapped = appWith(true, (tokens) => ({
      ...tokens,
      withToken: (workspaceId, use) =>
        tokens.withToken(workspaceId, (token) => use(token, "U0OTHER")),
    }));
    const before = slack.state.calls.length;
    const response = await swapped(startPath(GONE_AGENT), { cookie: owner() });
    expect([response.status, response.json?.error?.code]).toEqual([
      200,
      undefined,
    ]);
    const url = new URL(
      startSlackInstallResponseSchema.parse(response.json).authorize_url,
    );
    handled.push(url.searchParams.get("state") ?? "");
    expect(slack.state.calls.slice(before).map((c) => c.method)).not.toContain(
      "apps.manifest.export",
    );
  });

  test("an answer that does not say the app is gone still makes the link", async () => {
    await setup;
    for (const answer of ["no_permission", "ratelimited"]) {
      slack.state.next.export = async () => {
        throw new SlackApiError("apps.manifest.export", answer, true);
      };
      const url = new URL(await start(AGENT, owner()));
      handled.push(url.searchParams.get("state") ?? "");
    }
  });

  test("when Slack cannot say whether the app is there, the link is made", async () => {
    await setup;
    slack.state.next.export = async () => {
      throw new SlackApiError("apps.manifest.export", "timeout", false);
    };
    const url = new URL(await start(AGENT, owner()));
    handled.push(url.searchParams.get("state") ?? "");
    expect(url.searchParams.get("client_id")).toBe(appOf(AGENT).clientId);
  });
});

describe("completing an install", () => {
  test("start, Slack's consent and complete install the app in that order", async () => {
    await setup;
    const before = slack.state.calls.length;
    const { code: grant, state } = approve(await start(AGENT, admin()));
    const response = await complete(admin(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    expect([response.status, response.json?.error?.code]).toEqual([
      200,
      undefined,
    ]);
    expect(response.referrerPolicy).toBe("no-referrer");
    const app = appOf(AGENT);
    const body = completeSlackInstallResponseSchema.parse(response.json);
    expect(body).toMatchObject({
      slack_app: {
        id: app.id,
        secrets: { slack_bot_token: { configured: true } },
      },
      installation: {
        app_id: app.appId ?? "",
        team_id: "T0FAKE",
        bot_user_id: `U${app.appId}BOT`,
        status: "verified",
      },
      agent_identity: {
        agent_id: AGENT,
        app_id: app.appId ?? "",
        team_id: "T0FAKE",
        status: "active",
        credential_ref: `slack_app:${app.id}/slack_bot_token`,
      },
      finalized: true,
    });
    expect(body.receipt_id).not.toBeNull();
    expect(slack.state.calls.slice(before).map((c) => c.method)).toEqual([
      "apps.manifest.export",
      "oauth.v2.access",
      "auth.test",
      "bots.info",
    ]);
    expect(finalized).toEqual([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        slackAppId: app.id,
        appId: app.appId ?? "",
        teamId: "T0FAKE",
        botUserId: `U${app.appId}BOT`,
        installationId: body.installation.id,
        identityId: body.agent_identity.id,
      },
    ]);
    handled.push(...slack.install.botTokens.keys());

    const again = await complete(admin(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    expect([again.status, code(again.json)]).toMatchObject([
      409,
      {
        code: "SLACK_INSTALL_STATE_INVALID",
        details: { reason_code: "not_found" },
      },
    ]);
    expect(again.referrerPolicy).toBe("no-referrer");
  });

  test("installing again with a new link keeps one install and one identity", async () => {
    await setup;
    const { code: grant, state } = approve(await start(AGENT, owner()));
    const response = await complete(owner(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    expect(response.status).toBe(200);
    expect(response.json.receipt_id).toBeNull();
    handled.push(...slack.install.botTokens.keys());
    const app = appOf(AGENT);
    expect(
      [...installs.installations.keys()].filter((key) =>
        key.startsWith(`${app.appId}|`),
      ),
    ).toHaveLength(1);
    expect(
      identities.identities.filter((row) => row.agentId === AGENT),
    ).toHaveLength(1);
    expect(
      secrets.values.get(
        secrets.slotKey({
          workspaceId: WORKSPACE,
          owner: { kind: "slack_app", id: app.id },
          purpose: "slack_bot_token",
        }),
      )?.summary.secretVersion,
    ).toBe(2);
  });

  test("the state is spent whether Slack denied, refused or answered wrongly", async () => {
    await setup;
    const outcomes: [string, string][] = [];
    const denied = approve(await start(SECOND_AGENT, owner()));
    const deniedResponse = await complete(owner(), {
      agent_id: SECOND_AGENT,
      state: denied.state,
      error: "access_denied",
    });
    outcomes.push(["denied", code(deniedResponse.json).code]);

    const refused = approve(await start(SECOND_AGENT, owner()));
    const refusedResponse = await complete(owner(), {
      agent_id: SECOND_AGENT,
      state: refused.state,
      code: "not-the-code",
    });
    outcomes.push(["refused", code(refusedResponse.json).code]);
    expect(code(refusedResponse.json).details).toEqual({
      reason_code: "slack_error",
      slack_method: "oauth.v2.access",
      failure: "slack_error",
      slack_error: "invalid_code",
    });

    slack.install.grant = (grant) => ({ ...grant, scopes: ["chat:write"] });
    const narrow = approve(await start(SECOND_AGENT, owner()));
    const narrowResponse = await complete(owner(), {
      agent_id: SECOND_AGENT,
      state: narrow.state,
      code: narrow.code,
    });
    slack.install.grant = (grant) => grant;
    outcomes.push(["check failed", code(narrowResponse.json).code]);

    expect(outcomes).toEqual([
      ["denied", "SLACK_INSTALL_DENIED"],
      ["refused", "SLACK_INSTALL_REJECTED"],
      ["check failed", "SLACK_INSTALL_REJECTED"],
    ]);
    for (const used of [denied, refused, narrow]) {
      const reuse = await complete(owner(), {
        agent_id: SECOND_AGENT,
        state: used.state,
        code: used.code,
      });
      expect(code(reuse.json)).toMatchObject({
        code: "SLACK_INSTALL_STATE_INVALID",
        details: { reason_code: "not_found" },
      });
    }
  });

  test("an expired state, or one for another person, workspace, agent or app, is refused and spent", async () => {
    await setup;
    const refusal = async (
      cookie: string,
      body: { agent_id: string; state: string; code: string },
    ) => {
      const response = await complete(cookie, body);
      expect(response.status).toBe(409);
      expect(response.referrerPolicy).toBe("no-referrer");
      const error = code(response.json);
      expect(error.code).toBe("SLACK_INSTALL_STATE_INVALID");
      // Spent: the right caller cannot use it either.
      const retry = await complete(owner(), body);
      expect(code(retry.json).details).toEqual({ reason_code: "not_found" });
      return (error.details as { reason_code: string }).reason_code;
    };
    const before = slack.state.calls.length;

    const expiring = approve(await start(SECOND_AGENT, owner()));
    clock = new Date(clock.getTime() + 600_001);
    const expired = await refusal(owner(), {
      agent_id: SECOND_AGENT,
      ...expiring,
    });

    const elsewhere = approve(await start(SECOND_AGENT, owner()));
    const workspace = await refusal(
      cookieFor("owner", { workspaceId: OTHER_WORKSPACE, userId: OWNER }),
      { agent_id: SECOND_AGENT, ...elsewhere },
    );

    const theirs = approve(await start(SECOND_AGENT, owner()));
    const actor = await refusal(admin(), {
      agent_id: SECOND_AGENT,
      ...theirs,
    });

    const forAgent = approve(await start(SECOND_AGENT, owner()));
    const agent = await refusal(owner(), { agent_id: AGENT, ...forAgent });

    const forOldApp = approve(await start(SECOND_AGENT, owner()));
    const old = appOf(SECOND_AGENT);
    old.state = "deleted";
    apps.seed({ ...old, id: crypto.randomUUID(), state: "created" });
    const app = await refusal(owner(), {
      agent_id: SECOND_AGENT,
      ...forOldApp,
    });

    expect([expired, workspace, actor, agent, app]).toEqual([
      "expired",
      "workspace",
      "actor",
      "agent",
      "app",
    ]);
    // Only each start's check reached Slack.
    expect(
      slack.state.calls
        .slice(before)
        .filter((c) => c.method !== "apps.manifest.export"),
    ).toEqual([]);
  });

  test("Slack's answer for another app or team, an org install or missing scopes stores nothing", async () => {
    await setup;
    const app = appOf(REJECTED_AGENT);
    const cases: [string, (grant: never) => object][] = [
      ["app", () => ({ appId: "A0SOMEONEELSE" })],
      ["team", () => ({ teamId: "T0OTHER" })],
      ["enterprise", () => ({ enterpriseInstall: true, teamId: null })],
      [
        "scope",
        () => ({ scopes: BOT_SCOPES.filter((s) => s !== "chat:write") }),
      ],
    ];
    const before = slack.state.calls.length;
    const reasons: unknown[] = [];
    for (const [, patch] of cases) {
      slack.install.grant = (grant) => ({ ...grant, ...patch(grant as never) });
      const { code: grant, state } = approve(
        await start(REJECTED_AGENT, owner()),
      );
      const response = await complete(owner(), {
        agent_id: REJECTED_AGENT,
        state,
        code: grant,
      });
      expect(response.status).toBe(409);
      reasons.push(code(response.json).details);
    }
    slack.install.grant = (grant) => grant;
    handled.push(...slack.install.botTokens.keys());
    expect(reasons).toEqual([
      { reason_code: "app" },
      { reason_code: "team" },
      { reason_code: "enterprise" },
      { reason_code: "scope", missing_scopes: ["chat:write"] },
    ]);
    expect(slack.state.calls.slice(before).map((c) => c.method)).toEqual(
      Array(4).fill(["apps.manifest.export", "oauth.v2.access"]).flat(),
    );
    expect(botTokenSlots().filter((key) => key.includes(app.id))).toEqual([]);
    expect(
      [...installs.installations.keys()].filter((key) =>
        key.startsWith(`${app.appId}|`),
      ),
    ).toEqual([]);
    expect(
      identities.identities.filter((row) => row.agentId === REJECTED_AGENT),
    ).toEqual([]);
  });

  test("an app installed in that team for another workspace is refused", async () => {
    await setup;
    const app = appOf(CONFLICT_AGENT);
    installs.installations.set(`${app.appId}|T0FAKE`, {
      id: crypto.randomUUID(),
      workspaceId: OTHER_WORKSPACE,
      status: "verified",
      botUserId: "U0ELSEWHERE",
      verifiedAt: null,
    });
    const { code: grant, state } = approve(
      await start(CONFLICT_AGENT, owner()),
    );
    const response = await complete(owner(), {
      agent_id: CONFLICT_AGENT,
      state,
      code: grant,
    });
    handled.push(...slack.install.botTokens.keys());
    expect([response.status, code(response.json).code]).toEqual([
      409,
      "SLACK_INSTALL_CONFLICT",
    ]);
    expect(
      identities.identities.filter((row) => row.agentId === CONFLICT_AGENT),
    ).toEqual([]);
  });

  test("a failing Finalize leaves the install and says so", async () => {
    await setup;
    finalizeFaults.next = 1;
    const { code: grant, state } = approve(await start(AGENT, owner()));
    const response = await complete(owner(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    handled.push(...slack.install.botTokens.keys());
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      finalized: false,
      warnings: [{ code: "finalize_failed" }],
      installation: { status: "verified" },
    });
  });

  test("a member, an API key, a write without CSRF or a bad body is refused before the state", async () => {
    await setup;
    const { code: grant, state } = approve(await start(AGENT, owner()));
    const body = { agent_id: AGENT, state, code: grant };
    for (const response of [
      await complete(cookieFor("member"), body),
      await call(COMPLETE, { key: true, body }),
      await call(COMPLETE, { cookie: owner(), csrf: false, body }),
    ]) {
      expect(response.status).toBe(403);
      expect(code(response.json).code).toBe("FORBIDDEN");
    }
    for (const bad of [
      { agent_id: AGENT, state },
      { agent_id: AGENT, state, code: grant, error: "access_denied" },
      { agent_id: AGENT, state: "has spaces", code: grant },
    ]) {
      expect((await complete(owner(), bad as never)).status).toBe(400);
    }
    expect(
      (
        await call(COMPLETE, {
          cookie: owner(),
          body: `{"pad":"${"a".repeat(70_000)}"}`,
        })
      ).status,
    ).toBe(413);
    expect(
      (await appWith(false)(COMPLETE, { cookie: owner(), body })).status,
    ).toBe(503);
    // None of these spent it.
    const response = await complete(owner(), body);
    expect(response.status).toBe(200);
    handled.push(...slack.install.botTokens.keys());
  });

  test("an agent archived during the install is not found", async () => {
    await setup;
    const { code: grant, state } = approve(await start(AGENT, owner()));
    identities.archived.add(AGENT);
    const response = await complete(owner(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    identities.archived.delete(AGENT);
    handled.push(...slack.install.botTokens.keys());
    expect([response.status, code(response.json).code]).toEqual([
      404,
      "NOT_FOUND",
    ]);
  });

  test("an install revoked before the link is a declared conflict, not a 500", async () => {
    await setup;
    const { code: grant, state } = approve(await start(AGENT, owner()));
    const link = identities.store.link;
    identities.store.link = async () => ({ outcome: "not_installed" });
    const response = await complete(owner(), {
      agent_id: AGENT,
      state,
      code: grant,
    });
    identities.store.link = link;
    handled.push(...slack.install.botTokens.keys());
    expect([response.status, code(response.json).code]).toEqual([
      409,
      "REVISION_CONFLICT",
    ]);
  });

  test("Slack out of reach is a 503 that names how the call failed, and nothing is stored", async () => {
    await setup;
    const app = appOf(REJECTED_AGENT);
    const failures = [
      new SlackApiError("oauth.v2.access", "timeout", false, {
        failure: "timeout",
      }),
      new SlackApiError("oauth.v2.access", "unreachable", false, {
        failure: "unreachable",
      }),
      new SlackApiError("oauth.v2.access", "http_502", false, {
        httpStatus: 502,
        failure: "http_status",
      }),
      new SlackApiError("oauth.v2.access", "internal_error", false, {
        httpStatus: 503,
      }),
      new SlackApiError("oauth.v2.access", "unexpected_answer", false, {
        httpStatus: 200,
        failure: "unexpected_answer",
      }),
    ];
    const seen: unknown[] = [];
    for (const failure of failures) {
      slack.install.next.exchange = async () => {
        throw failure;
      };
      const { code: grant, state } = approve(
        await start(REJECTED_AGENT, owner()),
      );
      const before = logs.records.length;
      const response = await complete(owner(), {
        agent_id: REJECTED_AGENT,
        state,
        code: grant,
      });
      expect(response.status).toBe(503);
      // The install state is spent before Slack is asked, so the same request
      // cannot succeed later: the console must not be told to retry it.
      expect(code(response.json).retryable).toBe(false);
      const { details } = code(response.json);
      const logged = logs.records
        .slice(before)
        .filter((record) => record.message === "Slack install failed");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.fields).toEqual({
        agent_id: REJECTED_AGENT,
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        ...(details as object),
      });
      seen.push(details);
    }
    expect(seen).toEqual([
      {
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "timeout",
      },
      {
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "unreachable",
      },
      {
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "http_status",
        http_status: 502,
      },
      {
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "slack_error",
        http_status: 503,
        slack_error: "internal_error",
      },
      {
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "unexpected_answer",
        http_status: 200,
      },
    ]);
    expect(botTokenSlots().filter((key) => key.includes(app.id))).toEqual([]);
  });

  test("the app a failed attempt left without a bot token is the one the next install uses", async () => {
    await setup;
    const app = appOf(REJECTED_AGENT);
    slack.install.next.exchange = async () => {
      throw new SlackApiError("oauth.v2.access", "http_503", false, {
        httpStatus: 503,
        failure: "http_status",
      });
    };
    const unavailable = approve(await start(REJECTED_AGENT, owner()));
    const before = logs.records.length;
    expect(
      (
        await complete(owner(), {
          agent_id: REJECTED_AGENT,
          state: unavailable.state,
          code: unavailable.code,
        })
      ).status,
    ).toBe(503);
    slack.install.grant = (grant) => ({ ...grant, scopes: ["chat:write"] });
    const narrow = approve(await start(REJECTED_AGENT, owner()));
    const narrowResponse = await complete(owner(), {
      agent_id: REJECTED_AGENT,
      state: narrow.state,
      code: narrow.code,
    });
    slack.install.grant = (grant) => grant;
    handled.push(...slack.install.botTokens.keys());
    expect(code(narrowResponse.json).details).toMatchObject({
      reason_code: "scope",
      missing_scopes: expect.any(Array),
    });
    // Only the named fields reach the log; missing_scopes does not.
    expect(
      logs.records
        .slice(before)
        .filter((record) => record.message === "Slack install failed")
        .map((record) => record.fields),
    ).toEqual([
      {
        agent_id: REJECTED_AGENT,
        status: 503,
        code: "BACKEND_UNAVAILABLE",
        reason_code: "slack_no_answer",
        slack_method: "oauth.v2.access",
        failure: "http_status",
        http_status: 503,
      },
      {
        agent_id: REJECTED_AGENT,
        status: 409,
        code: "SLACK_INSTALL_REJECTED",
        reason_code: "scope",
      },
    ]);

    expect(appOf(REJECTED_AGENT)).toMatchObject({
      id: app.id,
      appId: app.appId,
      state: "created",
    });
    expect(botTokenSlots().filter((key) => key.includes(app.id))).toEqual([]);
    const { code: grant, state } = approve(
      await start(REJECTED_AGENT, owner()),
    );
    const response = await complete(owner(), {
      agent_id: REJECTED_AGENT,
      state,
      code: grant,
    });
    expect(response.status).toBe(200);
    handled.push(...slack.install.botTokens.keys());
    const installed = completeSlackInstallResponseSchema.parse(response.json);
    expect(installed.slack_app.id).toBe(app.id);
    expect(installed.installation.app_id).toBe(app.appId ?? "");
    expect(
      [...apps.rows.values()].filter((row) => row.agentId === REJECTED_AGENT),
    ).toHaveLength(1);
    expect(botTokenSlots().filter((key) => key.includes(app.id))).toHaveLength(
      1,
    );
  });

  test("no state, code or bot token appears in a response or a log line", () => {
    expect(handled.length).toBeGreaterThan(20);
    const text = [
      ...responses,
      ...logs.records.map((record) => JSON.stringify(record)),
    ].join("\n");
    for (const value of handled) expect(text).not.toContain(value);
    expect(text).not.toMatch(/xoxb-/);
    expect(
      logs.records.filter((record) => record.message === "Slack app installed"),
    ).toHaveLength(5);
  });
});
