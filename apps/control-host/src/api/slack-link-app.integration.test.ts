import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createSlackAppService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackLinkAppService,
  createSlackSecretService,
} from "@werft-ai/chat-slack";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listLinkedAccountsResponseSchema,
  scopesForRole,
  slackLinkCallbackResponseSchema,
  startSlackLinkResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresLinkedAccountStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  memberships,
  registerSlackInstallation,
  slackAppKind,
  slackApps,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  callerFor,
  createAuthorizationPolicy,
  createLinkedAccountService,
  MANAGEMENT_ROLES,
  SecretKey,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { createFakeSlackWebApi } from "@werft-ai/testkit/fake-slack-api";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerLinkedAccountRoutes } from "./routes/musterrolle/linked-accounts.ts";
import { registerSlackAppRoutes } from "./routes/surface/slack-apps.ts";
import { registerSlackSecretRoutes } from "./routes/surface/slack-secrets.ts";
import { SLACK_LINK_COOKIE_NAME } from "./slack-link.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const TEAM = "T0ACME";
const OTHER_TEAM = "T0GLOBEX";
const CONSOLE = "https://console.example.ts.net";
const LINK_REDIRECT = `${CONSOLE}/settings/linked-accounts/slack`;

integration("the workspace's link app, made on the first Slack link", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let idp: MockSlackOidc;
  const webApi = createFakeSlackWebApi({ teamId: TEAM, userId: "U0ISSUER" });
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
  const bootstrapToken = randomBytes(16).toString("hex");
  const password = randomBytes(12).toString("hex");
  const logs = new MemoryLogSink();
  const bodies: string[] = [];
  let tokens: ReturnType<typeof createSlackConfigTokens>;
  // Every app secret the fake handed out, kept past an app's deletion.
  const appSecrets = new Set<string>();
  afterEach(() => {
    for (const made of webApi.apps.values()) {
      appSecrets.add(made.clientSecret);
      appSecrets.add(made.signingSecret);
    }
  });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_link_app" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    idp = await startMockSlackOidc({ webApi });
    const identity = new DatabaseIdentityStore(db);
    const auth = {
      identity,
      bootstrap: createBootstrapGate(bootstrapToken),
      lockout: new LoginLockout(),
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    });
    const api = createSlackConfigApi({ apiUrl: `${idp.url}/api` });
    tokens = createSlackConfigTokens({
      store: createPostgresSlackConfigTokenStore(db, key),
      api,
    });
    const appStore = createPostgresSlackAppStore(db, key);
    const logger = new StructuredLogger({ sinks: [logs] });
    app = createApiApp({
      authMode: "api-key",
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      logger,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerLinkedAccountRoutes(router, {
          service: createLinkedAccountService({
            authorization,
            store: createPostgresLinkedAccountStore(db),
          }),
          github: { oauth: { client: async () => null }, redirectUri: null },
          slack: {
            issuer: idp.url,
            clients: createSlackLinkAppService({
              authorization,
              apps: appStore,
              tokens,
              api,
              consoleOrigin: CONSOLE,
            }),
          },
          logger,
        });
        registerSlackSecretRoutes(
          router,
          createSlackSecretService({
            authorization,
            store: createPostgresSecretStore(db, key),
            tokens,
            urls: { redirect_url: null, events_url_template: null },
            appKind: (workspaceId, slackAppId) =>
              slackAppKind(db, workspaceId, slackAppId),
          }),
        );
        registerSlackAppRoutes(router, {
          apps: createSlackAppService({
            authorization,
            apps: appStore,
            tokens,
            api,
            consoleOrigin: CONSOLE,
          }),
          secrets: createSlackSecretService({
            authorization,
            store: createPostgresSecretStore(db, key),
            tokens,
            urls: { redirect_url: null, events_url_template: null },
            appKind: (workspaceId, slackAppId) =>
              slackAppKind(db, workspaceId, slackAppId),
          }),
          logger,
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await idp?.stop();
    await pool?.end();
    await database?.drop();
  });

  async function request(path: string, init: RequestInit) {
    const response = await app.request(path, init);
    bodies.push(await response.clone().text());
    return response;
  }
  const send = (
    method: string,
    path: string,
    body: unknown,
    headers: HeadersInit = {},
  ) =>
    request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const cookieOf = (response: Response, name: string) => {
    const match = new RegExp(`${name}=([^;]+)`).exec(
      response.headers.get("Set-Cookie") ?? "",
    );
    return match ? `${name}=${match[1]}` : "";
  };
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  const errorOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;
  const creates = () =>
    webApi.calls.filter(
      (call) => call.method === "apps.manifest.create" && call.ok,
    ).length;

  let workspaceId = "";
  let ownerSession = "";
  let memberSession = "";

  async function addUser(
    target: string,
    email: string,
    role: "member" | "owner",
  ) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(password, {
          algorithm: "argon2id",
        }),
        displayName: email,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db
      .insert(memberships)
      .values({ workspaceId: target, userId: user.id, role });
    return user.id;
  }

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { email, password },
      { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    );
    expect(response.status).toBe(200);
    return cookieOf(response, "__Host-werft_session");
  }

  const start = (session: string, headers: HeadersInit = asCookie(session)) =>
    send("POST", "/v1/linked-accounts/slack/start", {}, headers);

  async function linkAs(session: string, mock: { team: string; user: string }) {
    const started = await start(session);
    expect(started.status).toBe(200);
    const { authorize_url } = startSlackLinkResponseSchema.parse(
      await started.json(),
    );
    const { code, state } = await idp.consent(
      `${authorize_url}&mock_team=${mock.team}&mock_user=${mock.user}`,
    );
    return send(
      "POST",
      "/v1/linked-accounts/slack/callback",
      { code, state },
      asCookie(`${session}; ${cookieOf(started, SLACK_LINK_COOKIE_NAME)}`),
    );
  }

  async function linkApps(target: string) {
    return db.select().from(slackApps).where(eq(slackApps.workspaceId, target));
  }

  test("setup: an owner and a member, and a verified Slack install", async () => {
    const boot = await send("POST", "/v1/auth/bootstrap", {
      bootstrap_token: bootstrapToken,
      email: "owner@example.com",
      password,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    });
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    const install = { appId: "A0SHARED", teamId: TEAM };
    await registerSlackInstallation(db, { ...install, workspaceId });
    await verifySlackInstallation(db, { ...install, botUserId: "U0BOT" });
    await addUser(workspaceId, "member@example.com", "member");
    ownerSession = await login("owner@example.com");
    memberSession = await login("member@example.com");
  });

  test("with no config token yet, a start is a typed refusal, not 503", async () => {
    const response = await start(memberSession);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "SLACK_LINK_NOT_CONFIGURED",
      details: { reason_code: "config_token" },
    });
    expect(await linkApps(workspaceId)).toEqual([]);
  });

  test("saving the config token makes no link app", async () => {
    const response = await send(
      "PUT",
      `/v1/workspaces/${workspaceId}/slack/config-token`,
      { value: webApi.issueConfigToken() },
      asCookie(ownerSession),
    );
    expect(response.status).toBe(200);
    expect(creates()).toBe(0);
    expect(await linkApps(workspaceId)).toEqual([]);
  });

  test("a start without the CSRF header, or with no session, makes nothing", async () => {
    expect((await start(memberSession, { Cookie: memberSession })).status).toBe(
      403,
    );
    expect((await start("", {})).status).toBe(401);
    expect(creates()).toBe(0);
  });

  let linkClientId = "";

  test("a member's first start makes the link app and sends them to it", async () => {
    const response = await start(memberSession);
    expect(response.status).toBe(200);
    const url = new URL(
      startSlackLinkResponseSchema.parse(await response.json()).authorize_url,
    );
    expect(creates()).toBe(1);
    const [row] = await linkApps(workspaceId);
    expect(row).toMatchObject({
      kind: "link",
      agentId: null,
      state: "created",
      redirectUrl: LINK_REDIRECT,
    });
    linkClientId = row?.clientId ?? "";
    expect(url.searchParams.get("client_id")).toBe(linkClientId);
    expect(url.searchParams.get("redirect_uri")).toBe(LINK_REDIRECT);
    expect(url.searchParams.get("scope")).toBe("openid profile");
    const made = webApi.apps.get(row?.appId ?? "");
    expect(made?.manifest).toEqual({
      display_information: {
        name: "Acme 계정 연결",
        description: "Werft 콘솔에서 Slack 계정을 연결합니다.",
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
  });

  test("more starts, sequential and concurrent, reuse it", async () => {
    const [first, second] = await Promise.all([
      start(memberSession),
      start(ownerSession),
    ]);
    const third = await start(memberSession);
    for (const response of [first, second, third]) {
      expect(response.status).toBe(200);
      const url = new URL(
        startSlackLinkResponseSchema.parse(await response.json()).authorize_url,
      );
      expect(url.searchParams.get("client_id")).toBe(linkClientId);
    }
    expect(creates()).toBe(1);
  });

  test("consent, callback, listed active, unlinked, then another team refused", async () => {
    const linked = await linkAs(memberSession, {
      team: TEAM,
      user: "U0MEMBER",
    });
    expect(linked.status).toBe(201);
    const account = slackLinkCallbackResponseSchema.parse(
      await linked.json(),
    ).linked_account;
    expect(account).toMatchObject({
      external_tenant: TEAM,
      external_user_id: "U0MEMBER",
      status: "active",
    });
    const list = async () =>
      listLinkedAccountsResponseSchema.parse(
        await (
          await request("/v1/linked-accounts", {
            headers: asCookie(memberSession),
          })
        ).json(),
      ).items;
    expect(await list()).toEqual([account]);

    const unlinked = await request(`/v1/linked-accounts/${account.id}`, {
      method: "DELETE",
      headers: asCookie(memberSession),
    });
    expect(unlinked.status).toBe(200);
    expect(await list()).toEqual([]);

    const mismatch = await linkAs(memberSession, {
      team: "T0ELSEWHERE",
      user: "U0OTHER",
    });
    expect(mismatch.status).toBe(409);
    expect((await errorOf(mismatch)).code).toBe("LINK_TEAM_MISMATCH");
    expect(creates()).toBe(1);
  });

  test("the link app's secrets cannot be written through the API", async () => {
    const [row] = await linkApps(workspaceId);
    for (const purpose of ["slack_client_secret", "slack_signing_secret"]) {
      const response = await send(
        "PUT",
        `/v1/workspaces/${workspaceId}/slack/apps/${row?.id}/secrets/${purpose}`,
        { value: randomBytes(16).toString("hex") },
        asCookie(ownerSession),
      );
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({
        code: "FORBIDDEN",
        details: { reason_code: "server_managed_secret" },
      });
    }
  });

  test("a member cannot delete it; an owner can, and the next start makes a new one", async () => {
    const [row] = await linkApps(workspaceId);
    const path = `/v1/workspaces/${workspaceId}/slack/apps/${row?.id}`;
    const refused = await request(path, {
      method: "DELETE",
      headers: asCookie(memberSession),
    });
    expect(refused.status).toBe(403);
    const deleted = await request(path, {
      method: "DELETE",
      headers: asCookie(ownerSession),
    });
    expect(deleted.status).toBe(200);
    expect((await start(memberSession)).status).toBe(200);
    expect(creates()).toBe(2);
    expect(
      (await linkApps(workspaceId)).map((app) => app.state).sort(),
    ).toEqual(["created", "deleted"]);
  });

  test("another workspace gets a link app of its own", async () => {
    const otherId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: otherId, slug: "globex", name: "Globex" });
    const install = { appId: "A0OTHER", teamId: OTHER_TEAM };
    await registerSlackInstallation(db, { ...install, workspaceId: otherId });
    await verifySlackInstallation(db, { ...install, botUserId: "U0BOT2" });
    const ownerId = await addUser(otherId, "globex@example.com", "owner");
    const stored = await tokens.register(otherId, webApi.issueConfigToken(), {
      principal: callerFor(
        {
          kind: "user",
          id: ownerId,
          workspace_id: otherId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        crypto.randomUUID(),
      ),
      receiptId: crypto.randomUUID(),
      roles: MANAGEMENT_ROLES["workspace.manage"] ?? [],
    });
    expect(stored.outcome).toBe("stored");
    const session = await login("globex@example.com");
    const response = await start(session);
    expect(response.status).toBe(200);
    const [own] = await linkApps(otherId);
    expect(own?.kind).toBe("link");
    const url = new URL(
      startSlackLinkResponseSchema.parse(await response.json()).authorize_url,
    );
    expect(url.searchParams.get("client_id")).toBe(own?.clientId ?? "");
    expect(own?.clientId).not.toBe(linkClientId);
    expect(creates()).toBe(3);
  });

  test("no response or log line carries a link app's secret", () => {
    const secrets = [...appSecrets];
    expect(secrets.length).toBe(6);
    const text = [
      ...bodies,
      ...logs.records.map((record) => JSON.stringify(record)),
    ].join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
