import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  githubLinkCallbackResponseSchema,
  LINK_MESSAGES,
  listLinkedAccountsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  slackLinkCallbackResponseSchema,
  startGitHubLinkResponseSchema,
  startSlackLinkResponseSchema,
  unlinkAccountResponseSchema,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  createAuthorizationPolicy,
  createLinkedAccountService,
  type LinkedAccountRecord,
  type LinkedAccountService,
  type LinkedAccountStore,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import { errorOf } from "../../../test-support/api-error.ts";
import { GITHUB_LINK_COOKIE_NAME } from "../../github-link.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  SLACK_LINK_COOKIE_NAME,
  type SlackOidcConfig,
} from "../../slack-link.ts";
import {
  type LinkedAccountRouteDeps,
  registerLinkedAccountRoutes,
} from "./linked-accounts.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/linked-accounts.test.ts",
);

const PERSON = "019a0000-0000-7000-8000-0000000000a1";
const GITHUB_CONNECTION = "019a0000-0000-7000-8000-0000000000c9";
let linkConnection = GITHUB_CONNECTION;
const LINK_ID = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const RECEIPT = "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10";
const TEAM = "T0INSTALLED";
const SLACK_USER = "U0PERSON";
const REDIRECT_URI = "https://werft.example/settings/linked-accounts/slack";

const allowing: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: crypto.randomUUID(),
  }),
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

const record: LinkedAccountRecord = {
  id: LINK_ID,
  workspaceId: "owner-a",
  userId: PERSON,
  provider: "slack",
  externalTenant: TEAM,
  externalUserId: SLACK_USER,
  externalTenantName: "Acme",
  externalUserName: "Alice",
  status: "active",
  verifiedAt: new Date("2026-10-11T00:00:00.000Z"),
  revision: 1,
};

function store(
  overrides: Partial<LinkedAccountStore> = {},
): LinkedAccountStore {
  return {
    installedSlackTeams: async () => [TEAM],
    link: async () => ({
      outcome: "linked",
      account: record,
      receiptId: RECEIPT,
    }),
    unlink: async () => ({ outcome: "unlinked", receiptId: RECEIPT }),
    list: async () => [record],
    resolveLinkedSubject: async () => ({ status: "unlinked" }),
    markStale: async () => ({ outcome: "not_found" }),
    ...overrides,
  };
}

function asPerson(caller: Caller): Caller {
  return {
    ...caller,
    actor: {
      principal: { kind: "user", id: PERSON },
      userId: PERSON,
      workspaceId: caller.ownerId,
      apiKeyId: null,
    },
  };
}

let idp: MockSlackOidc;
let slack: SlackOidcConfig;

beforeAll(async () => {
  idp = await startMockSlackOidc({
    account: { teamId: TEAM, userId: SLACK_USER },
  });
  slack = {
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: REDIRECT_URI,
    issuer: idp.url,
  };
});

afterAll(async () => {
  await idp.stop();
});

type SlackLinkClients = NonNullable<LinkedAccountRouteDeps["slack"]>["clients"];

/** One client for every workspace, as a fallback OIDC app is. */
function fixedClients(config: SlackOidcConfig): SlackLinkClients {
  const client = {
    source: "env" as const,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    slackAppId: null,
  };
  return {
    clientFor: async () => client,
    clientForStart: async () => client,
  };
}

function app(
  linkedStore: LinkedAccountStore = store(),
  options: {
    authorization?: AuthorizationPolicy;
    person?: boolean;
    slack?: SlackOidcConfig | null;
    clients?: Partial<SlackLinkClients>;
    github?: LinkedAccountRouteDeps["github"];
  } = {},
) {
  const config = options.slack === undefined ? slack : options.slack;
  const service = createLinkedAccountService({
    authorization: options.authorization ?? allowing,
    store: linkedStore,
  });
  const routed: LinkedAccountService =
    options.person === false
      ? service
      : {
          personFor: (caller) => service.personFor(asPerson(caller)),
          beginSlackLink: (caller) => service.beginSlackLink(asPerson(caller)),
          linkSlackAccount: (caller, verified) =>
            service.linkSlackAccount(asPerson(caller), verified),
          linkGitHubAccount: (caller, github) =>
            service.linkGitHubAccount(asPerson(caller), github),
          listLinkedAccounts: (caller) =>
            service.listLinkedAccounts(asPerson(caller)),
          unlinkAccount: (caller, id) =>
            service.unlinkAccount(asPerson(caller), id),
        };
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerLinkedAccountRoutes(router, {
        service: routed,
        github: options.github ?? {
          oauth: { client: async () => null },
          redirectUri: null,
        },
        slack:
          config === null
            ? null
            : {
                issuer: config.issuer,
                clients: { ...fixedClients(config), ...options.clients },
              },
      }),
  });
}

const owner = { "X-Owner-Id": "owner-a" };

function stateCookie(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = new RegExp(`${SLACK_LINK_COOKIE_NAME}=([^;]+)`).exec(header);
  if (!match) throw new Error("no state cookie");
  return `${SLACK_LINK_COOKIE_NAME}=${match[1]}`;
}

const start = (api: ReturnType<typeof app>, headers = owner) =>
  api.request("/v1/linked-accounts/slack/start", { method: "POST", headers });

const callback = (
  api: ReturnType<typeof app>,
  body: unknown,
  headers: Record<string, string> = owner,
) =>
  api.request("/v1/linked-accounts/slack/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** Start, consent at the mock IdP, and return what the callback needs. */
async function consented(api: ReturnType<typeof app>, mock?: string) {
  const started = await start(api);
  expect(started.status).toBe(200);
  const { authorize_url } = startSlackLinkResponseSchema.parse(
    await started.json(),
  );
  const consent = await idp.consent(
    mock ? `${authorize_url}&${mock}` : authorize_url,
  );
  return { ...consent, cookie: stateCookie(started), authorize_url };
}

describe("POST /v1/linked-accounts/slack/start", () => {
  test("sends the person to Slack's consent screen for the installed team, without email", async () => {
    const response = await start(app());
    expect(response.status).toBe(200);
    const body = startSlackLinkResponseSchema.parse(await response.json());
    const url = new URL(body.authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${idp.url}/openid/connect/authorize`,
    );
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("team")).toBe(TEAM);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain(`${SLACK_LINK_COOKIE_NAME}=`);
    expect(SLACK_LINK_COOKIE_NAME).toBe("werft_slack_link");
    expect(SLACK_LINK_COOKIE_NAME).not.toBe("ap_slack_link");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/v1/linked-accounts/slack");
  });

  test("names no team when the workspace has several installs", async () => {
    const response = await start(
      app(store({ installedSlackTeams: async () => [TEAM, "T0OTHER"] })),
    );
    const body = startSlackLinkResponseSchema.parse(await response.json());
    expect(new URL(body.authorize_url).searchParams.has("team")).toBe(false);
  });

  test("a workspace without a verified Slack install is refused before Slack", async () => {
    const response = await start(
      app(store({ installedSlackTeams: async () => [] })),
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "SLACK_NOT_INSTALLED",
      message: LINK_MESSAGES.notInstalled,
    });
  });

  test("without a login, says who can invite a person with no account", async () => {
    const response = await start(app(), {} as typeof owner);
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toMatchObject({
      code: "UNAUTHORIZED",
      message:
        "웹에 로그인한 뒤 다시 열어 주세요. 계정이 없으면 owner·admin에게 초대를 요청하세요",
    });
  });

  test("an API key cannot link", async () => {
    const response = await start(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("answers 503 when Sign in with Slack is not configured", async () => {
    const response = await start(app(store(), { slack: null }));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("BACKEND_UNAVAILABLE");
  });

  test("sends the person to the workspace's own client", async () => {
    const response = await start(
      app(store(), {
        clients: {
          clientForStart: async (caller) => ({
            source: "link_app",
            clientId: `link-${caller.ownerId}`,
            clientSecret: "unused",
            redirectUri:
              "https://console.example/settings/linked-accounts/slack",
            slackAppId: crypto.randomUUID(),
          }),
        },
      }),
    );
    const url = new URL(
      startSlackLinkResponseSchema.parse(await response.json()).authorize_url,
    );
    expect(url.searchParams.get("client_id")).toBe("link-owner-a");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://console.example/settings/linked-accounts/slack",
    );
  });

  test("nothing to link with is a typed 409 with guidance, not 503", async () => {
    const response = await start(
      app(store(), {
        clients: {
          clientForStart: async () => {
            throw new SessionServiceError(
              "SLACK_LINK_NOT_CONFIGURED",
              "Slack account linking is not set up for this workspace",
              undefined,
              { reason_code: "config_token" },
            );
          },
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "SLACK_LINK_NOT_CONFIGURED",
      details: { reason_code: "config_token" },
    });
  });

  test("no client is resolved, nor app made, for someone who may not link", async () => {
    let asked = 0;
    const clientForStart = async () => {
      asked += 1;
      throw new Error("must not be reached");
    };
    const refused = await start(
      app(store({ installedSlackTeams: async () => [] }), {
        clients: { clientForStart },
      }),
    );
    expect(refused.status).toBe(409);
    expect(asked).toBe(0);
  });
});

describe("POST /v1/linked-accounts/slack/callback", () => {
  test("links the account Slack verified and spends the state", async () => {
    const api = app();
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(201);
    expect(
      slackLinkCallbackResponseSchema.parse(await response.json()),
    ).toEqual({
      linked_account: {
        id: LINK_ID,
        user_id: PERSON,
        provider: "slack",
        external_tenant: TEAM,
        external_user_id: SLACK_USER,
        external_tenant_name: "Acme",
        external_user_name: "Alice",
        status: "active",
        verified_at: "2026-10-11T00:00:00.000Z",
        revision: 1,
        expires_at: null,
      },
      receipt_id: RECEIPT,
    });
    expect(response.headers.get("Set-Cookie")).toContain(
      `${SLACK_LINK_COOKIE_NAME}=;`,
    );
  });

  test("exchanges the code with the workspace's client and never makes one", async () => {
    const asked: string[] = [];
    const fixed = fixedClients(slack);
    const api = app(store(), {
      clients: {
        clientFor: async (workspaceId) => {
          asked.push(workspaceId);
          return fixed.clientFor(workspaceId);
        },
        clientForStart: fixed.clientForStart,
      },
    });
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(201);
    expect(asked).toEqual(["owner-a"]);
  });

  test("a workspace that lost its client since the start is told to start over", async () => {
    const fixed = fixedClients(slack);
    const api = app(store(), {
      clients: {
        clientFor: async () => null,
        clientForStart: fixed.clientForStart,
      },
    });
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(LINK_MESSAGES.expired);
  });

  test("hands the store exactly the team, user and names from the id_token", async () => {
    let linked: unknown;
    const api = app(
      store({
        link: async (input) => {
          linked = { account: input.account, names: input.names };
          return { outcome: "linked", account: record, receiptId: RECEIPT };
        },
      }),
    );
    const { code, state, cookie } = await consented(
      api,
      "mock_team=T0ELSEWHERE&mock_user=U0SOMEONE&mock_user_name=Someone",
    );
    await callback(api, { code, state }, { ...owner, Cookie: cookie });
    expect(linked).toEqual({
      account: {
        provider: "slack",
        externalTenant: "T0ELSEWHERE",
        externalUserId: "U0SOMEONE",
      },
      names: { externalTenantName: null, externalUserName: "Someone" },
    });
  });

  test("a state without its cookie, or a code used twice, is refused", async () => {
    const api = app();
    const { code, state, cookie } = await consented(api);
    const noCookie = await callback(api, { code, state });
    expect(noCookie.status).toBe(400);
    expect((await errorOf(noCookie)).message).toBe(LINK_MESSAGES.expired);

    const wrongState = await callback(
      api,
      { code, state: "not-the-state" },
      { ...owner, Cookie: cookie },
    );
    expect(wrongState.status).toBe(400);

    const fresh = await consented(api);
    const headers = { ...owner, Cookie: fresh.cookie };
    expect(
      (await callback(api, { code: fresh.code, state: fresh.state }, headers))
        .status,
    ).toBe(201);
    // The code is spent at Slack; the cookie the browser still sent is too.
    expect(
      (await callback(api, { code: fresh.code, state: fresh.state }, headers))
        .status,
    ).toBe(400);
  });

  test("a malformed body is a bad request", async () => {
    const response = await callback(app(), { code: "" });
    expect(response.status).toBe(400);
  });

  test("another Slack team is refused with the workspace to use instead", async () => {
    const api = app(
      store({
        link: async () => ({ outcome: "team_mismatch", workspaceName: "Acme" }),
      }),
    );
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "LINK_TEAM_MISMATCH",
      message:
        "이 Slack 워크스페이스는 연결된 곳이 아니에요. Acme 워크스페이스 계정으로 다시 시도하세요",
    });
  });

  test("an account linked to someone else is refused, not overwritten", async () => {
    const api = app(store({ link: async () => ({ outcome: "taken" }) }));
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "LINK_TAKEN",
      message:
        "이 Slack 계정은 다른 사용자에게 연결돼 있어요. owner·admin에게 문의하세요",
    });
  });

  test("a second account in the same team is refused", async () => {
    const api = app(store({ link: async () => ({ outcome: "exists" }) }));
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("LINK_EXISTS");
  });

  test("an API key cannot finish a link", async () => {
    const response = await callback(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
      { code: "x", state: "y" },
    );
    expect(response.status).toBe(403);
  });

  test("an offboarded caller is refused", async () => {
    const api = app(
      store({ link: async () => ({ outcome: "actor_inactive" }) }),
    );
    const { code, state, cookie } = await consented(api);
    const response = await callback(
      api,
      { code, state },
      { ...owner, Cookie: cookie },
    );
    expect(response.status).toBe(403);
  });

  test("requires authentication", async () => {
    const response = await callback(app(), { code: "x", state: "y" }, {});
    expect(response.status).toBe(401);
  });

  test("an oversized body is refused", async () => {
    const response = await callback(app(), {
      code: "x".repeat(2_000_000),
      state: "y",
    });
    expect(response.status).toBe(413);
  });

  test("Slack being unreachable is a retryable 503", async () => {
    const api = app(store(), {
      slack: { ...slack, issuer: "http://127.0.0.1:9" },
    });
    const started = await start(api);
    const { authorize_url } = startSlackLinkResponseSchema.parse(
      await started.json(),
    );
    const state = new URL(authorize_url).searchParams.get("state") ?? "";
    const response = await callback(
      api,
      { code: "any", state },
      { ...owner, Cookie: stateCookie(started) },
    );
    expect(response.status).toBe(503);
    expect((await errorOf(response)).retryable).toBe(true);
  });
});

describe("GET /v1/linked-accounts", () => {
  test("lists the caller's links", async () => {
    const response = await app().request("/v1/linked-accounts", {
      headers: owner,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(listLinkedAccountsResponseSchema.parse(body).items).toEqual([
      expect.objectContaining({ id: LINK_ID, status: "active" }),
    ]);
    // Pinned so no token or secret field can slip into the response.
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "expires_at",
      "external_tenant",
      "external_tenant_name",
      "external_user_id",
      "external_user_name",
      "id",
      "provider",
      "revision",
      "status",
      "user_id",
      "verified_at",
    ]);
    // Slack keeps no token, so nothing expires.
    expect(body.items[0].expires_at).toBeNull();
  });

  test("an API key is refused", async () => {
    const response = await app(store(), {
      authorization: createAuthorizationPolicy(),
      person: false,
    }).request("/v1/linked-accounts", { headers: owner });
    expect(response.status).toBe(403);
  });

  test("requires authentication", async () => {
    expect((await app().request("/v1/linked-accounts")).status).toBe(401);
  });

  test("maps a storage outage to 503", async () => {
    const response = await app(store({ list: outage })).request(
      "/v1/linked-accounts",
      { headers: owner },
    );
    expect(response.status).toBe(503);
  });
});

describe("DELETE /v1/linked-accounts/{id}", () => {
  const unlink = (
    api: ReturnType<typeof app>,
    id = LINK_ID,
    headers: Record<string, string> = owner,
  ) =>
    api.request(`/v1/linked-accounts/${id}`, {
      method: "DELETE",
      headers,
    });

  test("unlinks and returns the receipt", async () => {
    const response = await unlink(app());
    expect(response.status).toBe(200);
    expect(unlinkAccountResponseSchema.parse(await response.json())).toEqual({
      receipt_id: RECEIPT,
      receipt_status: "succeeded",
    });
  });

  test("someone else's link and a malformed id are both not found", async () => {
    const missing = await unlink(
      app(store({ unlink: async () => ({ outcome: "not_found" }) })),
    );
    expect(missing.status).toBe(404);
    expect((await unlink(app(), "not-a-uuid")).status).toBe(404);
  });

  test("an API key is refused", async () => {
    const response = await unlink(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("requires authentication", async () => {
    expect((await unlink(app(), LINK_ID, {})).status).toBe(401);
  });

  test("maps a storage outage to 503", async () => {
    expect((await unlink(app(store({ unlink: outage })))).status).toBe(503);
  });
});

// GitHub's side of the author App's user authorization: the code for a user
// token, the token for `GET /user`. The token is made per run, never written.
const githubAccount = { id: 583231, login: "octocat" };
let githubServer: ReturnType<typeof Bun.serve>;
let githubIssued = "";
const githubExchanges: Array<Record<string, unknown>> = [];

beforeAll(() => {
  githubIssued = crypto.randomUUID();
  githubServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login/oauth/access_token") {
        const sent = (await request.json()) as Record<string, unknown>;
        githubExchanges.push(sent);
        if (sent.code === "down") return new Response("", { status: 502 });
        return Response.json(
          sent.code === "good"
            ? { access_token: githubIssued, token_type: "bearer" }
            : { error: "bad_verification_code" },
        );
      }
      if (url.pathname === "/api/v3/user") {
        return request.headers.get("authorization") === `Bearer ${githubIssued}`
          ? Response.json(githubAccount)
          : Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  githubServer.stop(true);
});

const GITHUB_REDIRECT =
  "https://console.example/settings/linked-accounts/github";

function githubDeps(): LinkedAccountRouteDeps["github"] {
  const base = `http://127.0.0.1:${githubServer.port}`;
  return {
    oauth: {
      client: async () => ({
        connectionId: linkConnection,
        clientId: "Iv23liTestClient",
        // The fake does not check it.
        clientSecret: "",
        webBase: base,
        apiBase: `${base}/api/v3`,
      }),
    },
    redirectUri: GITHUB_REDIRECT,
  };
}

const githubRecord: LinkedAccountRecord = {
  ...record,
  provider: "github",
  externalTenant: "github.com",
  externalUserId: "583231",
  externalTenantName: "GitHub",
  externalUserName: "octocat",
};

function githubApp(linkedStore: LinkedAccountStore = store()) {
  return app(linkedStore, { github: githubDeps() });
}

const githubStart = (api: ReturnType<typeof app>, headers = owner) =>
  api.request("/v1/linked-accounts/github/start", { method: "POST", headers });

const githubCallback = (
  api: ReturnType<typeof app>,
  body: unknown,
  headers: Record<string, string> = owner,
) =>
  api.request("/v1/linked-accounts/github/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function githubCookie(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const match = new RegExp(`${GITHUB_LINK_COOKIE_NAME}=([^;]+)`).exec(header);
  if (!match?.[1]) throw new Error("no state cookie");
  expect(header).toStartWith("werft_github_link=");
  return match[1];
}

async function githubStarted(api: ReturnType<typeof app>) {
  const started = await githubStart(api);
  expect(started.status).toBe(200);
  const { authorize_url } = startGitHubLinkResponseSchema.parse(
    await started.json(),
  );
  const state = new URL(authorize_url).searchParams.get("state") ?? "";
  return { state, cookie: githubCookie(started), authorize_url };
}

describe("POST /v1/linked-accounts/github/start", () => {
  test("sends the person to the author App's consent screen with a state cookie for the callback", async () => {
    const { authorize_url, state, cookie } = await githubStarted(githubApp());
    const url = new URL(authorize_url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `http://127.0.0.1:${githubServer.port}/login/oauth/authorize`,
    );
    expect(url.searchParams.get("client_id")).toBe("Iv23liTestClient");
    expect(url.searchParams.get("redirect_uri")).toBe(GITHUB_REDIRECT);
    expect(url.searchParams.get("allow_signup")).toBe("false");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(state.length).toBeGreaterThan(20);
    expect(cookie.startsWith(`${state}.${PERSON}.`)).toBe(true);
  });

  test("not configured is a typed 409 before anything is sent", async () => {
    for (const github of [
      undefined,
      { oauth: { client: async () => null }, redirectUri: GITHUB_REDIRECT },
      { ...githubDeps(), redirectUri: null },
    ]) {
      const response = await githubStart(
        app(store(), github === undefined ? {} : { github }),
      );
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toMatchObject({
        code: "GITHUB_LINK_NOT_CONFIGURED",
        message: LINK_MESSAGES.githubUnset,
        details: { reason_code: "github_oauth_unset" },
      });
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
  });

  test("an API key cannot link", async () => {
    const response = await githubStart(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
        github: githubDeps(),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /v1/linked-accounts/github/callback", () => {
  test("links the account GET /user names, keeping its id and login and no token", async () => {
    const links: unknown[] = [];
    const api = githubApp(
      store({
        link: async (input) => {
          links.push(input);
          return {
            outcome: "linked",
            account: githubRecord,
            receiptId: RECEIPT,
          };
        },
      }),
    );
    const { state, cookie } = await githubStarted(api);
    const response = await githubCallback(
      api,
      { code: "good", state },
      { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}` },
    );
    expect(response.status).toBe(201);
    expect(
      githubLinkCallbackResponseSchema.parse(await response.json()),
    ).toMatchObject({
      linked_account: {
        provider: "github",
        external_tenant: "github.com",
        external_user_id: "583231",
        external_user_name: "octocat",
      },
      receipt_id: RECEIPT,
    });
    expect(links).toEqual([
      expect.objectContaining({
        userId: PERSON,
        account: {
          provider: "github",
          externalTenant: "github.com",
          externalUserId: "583231",
        },
        names: { externalTenantName: "GitHub", externalUserName: "octocat" },
      }),
    ]);
    expect(JSON.stringify(links)).not.toContain(githubIssued);
    expect(githubExchanges.at(-1)).toMatchObject({
      client_id: "Iv23liTestClient",
      code: "good",
      redirect_uri: GITHUB_REDIRECT,
    });
    expect(response.headers.get("Set-Cookie")).toContain(
      `${GITHUB_LINK_COOKIE_NAME}=;`,
    );
  });

  test("a state is spent by its first callback: reusing it is 400", async () => {
    const api = githubApp();
    const { state, cookie } = await githubStarted(api);
    const headers = {
      ...owner,
      Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}`,
    };
    const first = await githubCallback(api, { code: "good", state }, headers);
    expect(first.status).toBe(201);
    // The browser drops the cookie on the answer; one that kept it is no
    // better off once the cookie is replayed without the browser.
    const replayed = await githubCallback(
      api,
      { code: "good", state },
      {
        ...owner,
        Cookie: first.headers.get("Set-Cookie")?.split(";")[0] ?? "",
      },
    );
    expect(replayed.status).toBe(400);
    expect((await errorOf(replayed)).message).toBe(LINK_MESSAGES.expired);
  });

  test("an expired state is 400, even with its cookie still sent", async () => {
    const api = githubApp();
    const exchangesBefore = githubExchanges.length;
    const { state, cookie } = await githubStarted(api);
    const [value, user, , connection] = cookie.split(".");
    const expired = `${value}.${user}.${Date.now() - 1}.${connection}`;
    const response = await githubCallback(
      api,
      { code: "good", state },
      { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${expired}` },
    );
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(LINK_MESSAGES.expired);
    expect(githubExchanges.length).toBe(exchangesBefore);
  });

  test("a link started before the linking App changed is 400 and its code is not exchanged", async () => {
    const api = githubApp();
    const exchangesBefore = githubExchanges.length;
    const { state, cookie } = await githubStarted(api);
    expect(cookie.split(".")[3]).toBe(GITHUB_CONNECTION);
    linkConnection = "019a0000-0000-7000-8000-0000000000ca";
    try {
      const response = await githubCallback(
        api,
        { code: "good", state },
        { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}` },
      );
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toBe(LINK_MESSAGES.expired);
    } finally {
      linkConnection = GITHUB_CONNECTION;
    }
    expect(githubExchanges.length).toBe(exchangesBefore);
  });

  test("another state, or another person's cookie, is 400 and GitHub is not asked", async () => {
    const api = githubApp();
    const exchangesBefore = githubExchanges.length;
    const { state, cookie } = await githubStarted(api);
    const [value, , expires] = cookie.split(".");
    for (const [sentState, sentCookie] of [
      ["other-state", cookie],
      [state, `${value}.019a0000-0000-7000-8000-0000000000ff.${expires}`],
      [state, undefined],
    ] as const) {
      const response = await githubCallback(
        api,
        { code: "good", state: sentState },
        sentCookie === undefined
          ? owner
          : { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${sentCookie}` },
      );
      expect(response.status).toBe(400);
    }
    expect(githubExchanges.length).toBe(exchangesBefore);
  });

  test("an oversized body is 413", async () => {
    const response = await githubCallback(githubApp(), {
      code: "x".repeat(REQUEST_BODY_MAX_BYTES),
      state: "s",
    });
    expect(response.status).toBe(413);
  });

  test("a code GitHub refuses is 400; GitHub down is 503", async () => {
    const api = githubApp();
    for (const [code, status] of [
      ["bad", 400],
      ["down", 503],
    ] as const) {
      const { state, cookie } = await githubStarted(api);
      const response = await githubCallback(
        api,
        { code, state },
        { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}` },
      );
      expect(response.status).toBe(status);
    }
  });

  test("a GitHub account linked to someone else is 409 LINK_TAKEN; a second GitHub account is 409 LINK_EXISTS", async () => {
    for (const [outcome, code, message] of [
      ["taken", "LINK_TAKEN", LINK_MESSAGES.githubTaken],
      ["exists", "LINK_EXISTS", LINK_MESSAGES.githubExists],
    ] as const) {
      const api = githubApp(store({ link: async () => ({ outcome }) }));
      const { state, cookie } = await githubStarted(api);
      const response = await githubCallback(
        api,
        { code: "good", state },
        { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}` },
      );
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toMatchObject({ code, message });
    }
  });

  test("set-up removed between start and callback is a typed 409", async () => {
    let configured = true;
    const deps = githubDeps();
    const api = app(store(), {
      github: {
        ...deps,
        oauth: {
          client: async (workspaceId) =>
            configured ? deps.oauth.client(workspaceId) : null,
        },
      },
    });
    const { state, cookie } = await githubStarted(api);
    configured = false;
    const response = await githubCallback(
      api,
      { code: "good", state },
      { ...owner, Cookie: `${GITHUB_LINK_COOKIE_NAME}=${cookie}` },
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("GITHUB_LINK_NOT_CONFIGURED");
  });
});
