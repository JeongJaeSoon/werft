import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  disableLoginProviderResponseSchema,
  discoverLoginProviderResponseSchema,
  LOGIN_FLOW_COOKIE_NAME,
  type LoginProviderView,
  listLoginProvidersResponseSchema,
  loginMethodsResponseSchema,
  loginProviderResponseSchema,
  providerLoginCallbackResponseSchema,
  startProviderLoginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresLoginProviderAdminStore,
  createPostgresLoginProviderStore,
  loginMethods,
  receipts,
  secretValues,
  users,
  webSessions,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  derivedSecretKey,
  SecretKey,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { like } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { createProviderAdmin } from "./provider-admin.ts";
import { createProviderLogin } from "./provider-login.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerLoginProviderRoutes } from "./routes/login-providers.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "bootstrap-token-for-the-provider-admin-test";
const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "werft-console";
const CLIENT_SECRET = "the-secret-the-provider-takes";
const WRONG_SECRET = "a-secret-the-provider-refuses";
const KEY = SecretKey.fromHex("cd".repeat(32), "test");
// On loopback, so the stand-in provider's plain http is allowed.
const CONSOLE_ORIGIN = "http://localhost:5173";
const BROWSER = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const BASE = "/v1/login-providers";

const alice: MockOidcClaims = {
  sub: "1001",
  email: "alice@example.com",
  name: "Alice",
};

/**
 * The owner's way through the settings, start to end, against the routes
 * the server registers: make a provider, fill it in, test it, turn it on,
 * replace its secret, turn it off, delete it. The tests run in order and
 * each leaves the provider where the next one picks it up.
 */
integration("sign-in provider settings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let idp: MockOidcServer;
  let app: ReturnType<typeof createApiApp>;
  let owner = "";
  let ownerId = "";
  let workspaceId = "";
  let provider: LoginProviderView;

  const send = (
    method: string,
    path: string,
    options: { cookie?: string; body?: unknown; ifMatch?: number } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...BROWSER,
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.ifMatch === undefined
          ? {}
          : { "If-Match": String(options.ifMatch) }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  const cookieOf = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.split(";")[0] ?? "";
  const providerOf = async (response: Response) => {
    expect(response.status).toBe(200);
    provider = loginProviderResponseSchema.parse(
      await response.json(),
    ).provider;
    return provider;
  };
  const refusalOf = async (response: Response) => {
    const { error } = await response.json();
    return {
      status: response.status,
      code: error.code,
      reason: error.details?.reason_code,
    };
  };
  const path = (suffix = "") => `${BASE}/${provider.id}${suffix}`;
  /** A test sign-in from the owner's session, through to its answer. */
  const runTest = async (claims: MockOidcClaims = alice, session = owner) => {
    const started = await send("POST", path("/test/start"), { cookie: owner });
    expect(started.status).toBe(200);
    const flowCookie = cookieOf(started, LOGIN_FLOW_COOKIE_NAME);
    const { authorization_url } = startProviderLoginResponseSchema.parse(
      await started.json(),
    );
    const back = await idp.authorize(authorization_url, claims);
    return send("POST", "/v1/auth/oidc/callback", {
      cookie: [flowCookie, session].filter(Boolean).join("; "),
      body: { provider_id: provider.id, ...back },
    });
  };
  /** A person signing in with the provider from the login page. */
  const signIn = async (claims: MockOidcClaims) => {
    const started = await send(
      "POST",
      `/v1/auth/providers/${provider.id}/start`,
    );
    if (started.status !== 200) return started;
    const { authorization_url } = startProviderLoginResponseSchema.parse(
      await started.json(),
    );
    const back = await idp.authorize(authorization_url, claims);
    return send("POST", "/v1/auth/oidc/callback", {
      cookie: cookieOf(started, LOGIN_FLOW_COOKIE_NAME),
      body: { provider_id: provider.id, ...back },
    });
  };
  const counts = async () => ({
    users: (await db.select().from(users)).length,
    sessions: (await db.select().from(webSessions)).length,
    methods: (await db.select().from(loginMethods)).length,
  });
  const operations = async () =>
    (
      await db
        .select()
        .from(receipts)
        .where(like(receipts.operation, "%login_provider%"))
        .orderBy(receipts.createdAt)
    ).map((row) => row.operation);

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "provider_admin" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    idp = await startMockOidcServer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    const identity = new DatabaseIdentityStore(db);
    const store = createPostgresLoginProviderAdminStore(db, KEY);
    const providers = createProviderLogin({
      providers: createPostgresLoginProviderStore(db, KEY),
      admin: store,
      consoleOrigin: CONSOLE_ORIGIN,
      flowKey: derivedSecretKey(KEY, "login-flow-cookie"),
    });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
      providers,
    };
    const admin = createProviderAdmin({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store,
      login: providers,
      consoleOrigin: CONSOLE_ORIGIN,
    });
    app = createApiApp({
      authMode: "api-key",
      keyStore: { find: async () => null },
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerLoginProviderRoutes(router, admin);
      },
    });

    const created = await send("POST", "/v1/auth/bootstrap", {
      body: {
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    });
    expect(created.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await created.json());
    ownerId = body.user_id;
    workspaceId = body.workspace.id;
    const login = await send("POST", "/v1/auth/login", {
      body: { email: "owner@example.com", password: PASSWORD },
    });
    expect(login.status).toBe(200);
    owner = cookieOf(login, WEB_SESSION_COOKIE_NAME);
    expect(owner).not.toBe("");
  }, 60_000);

  afterAll(async () => {
    idp?.stop();
    await pool?.end();
    await database?.drop();
  });

  test("the routes are behind a console session", async () => {
    expect((await send("GET", BASE)).status).toBe(401);
    const listed = await send("GET", BASE, { cookie: owner });
    expect(listed.status).toBe(200);
    expect(listLoginProvidersResponseSchema.parse(await listed.json())).toEqual(
      { providers: [], console_origin_configured: true },
    );
  });

  test("an issuer is checked before anything is kept, and made into a provider that is off", async () => {
    const checked = await send("POST", `${BASE}/discover`, {
      cookie: owner,
      body: { issuer: idp.issuer },
    });
    expect(checked.status).toBe(200);
    expect(
      discoverLoginProviderResponseSchema.parse(await checked.json()),
    ).toMatchObject({
      outcome: "ok",
      endpoint_hosts: [new URL(idp.issuer).host],
    });
    expect(await operations()).toEqual([]);

    const made = await send("POST", BASE, {
      cookie: owner,
      body: { display_name: "Keycloak", issuer: idp.issuer },
    });
    expect(made.status).toBe(201);
    provider = loginProviderResponseSchema.parse(await made.json()).provider;
    expect(provider).toMatchObject({
      display_name: "Keycloak",
      issuer: idp.issuer,
      redirect_uri: `${CONSOLE_ORIGIN}/auth/callback/${provider.id}`,
      token_endpoint: `${idp.issuer}/token`,
      client_id: null,
      client_secret: null,
      state: "draft",
      revision: 1,
    });
    // Off: the login page does not offer it and a sign-in does not start.
    const methods = loginMethodsResponseSchema.parse(
      await (await send("GET", "/v1/auth/login-methods")).json(),
    );
    expect(methods.providers).toEqual([]);
    expect((await signIn(alice)).status).toBe(404);

    const again = await send("POST", BASE, {
      cookie: owner,
      body: { display_name: "Again", issuer: idp.issuer },
    });
    expect((await refusalOf(again)).code).toBe("ALREADY_EXISTS");
  });

  test("it cannot be tested or turned on before its client is filled in", async () => {
    expect(
      await refusalOf(
        await send("POST", path("/test/start"), { cookie: owner }),
      ),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT", reason: "not_tested" });
    expect(
      await refusalOf(await send("POST", path("/enable"), { cookie: owner })),
    ).toEqual({ status: 409, code: "REVISION_CONFLICT", reason: "not_tested" });
  });

  test("the client ID and the secret are set; the secret is stored encrypted and never shown", async () => {
    const stale = await send("PATCH", path(), {
      cookie: owner,
      ifMatch: provider.revision + 1,
      body: { client_id: CLIENT_ID },
    });
    expect(stale.status).toBe(412);
    expect(
      (await send("PATCH", path(), { cookie: owner, body: {} })).status,
    ).toBe(400);
    expect(
      (
        await send("PATCH", path(), {
          cookie: owner,
          body: { client_id: CLIENT_ID },
        })
      ).status,
    ).toBe(428);

    await providerOf(
      await send("PATCH", path(), {
        cookie: owner,
        ifMatch: provider.revision,
        body: { client_id: CLIENT_ID, token_auth_method: "client_secret_post" },
      }),
    );
    expect(provider.state).toBe("draft");

    const stored = await send("PUT", path("/client-secret"), {
      cookie: owner,
      body: { value: CLIENT_SECRET },
    });
    const text = await stored.clone().text();
    expect(text).not.toContain(CLIENT_SECRET);
    await providerOf(stored);
    expect(provider.client_secret?.last4).toBe(CLIENT_SECRET.slice(-4));
    expect(provider.state).toBe("needs_test");

    const rows = await db.select().from(secretValues);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CLIENT_SECRET);
    // Still off until a test passes.
    expect(
      (await refusalOf(await send("POST", path("/enable"), { cookie: owner })))
        .reason,
    ).toBe("not_tested");
  });

  test("a test that fails says why and unlocks nothing", async () => {
    const before = await counts();
    const failed = await runTest({ ...alice, aud: "someone-else" });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      outcome: "tested",
      provider_id: provider.id,
      test: { passed: false, reason: "audience_mismatch" },
    });
    expect(await counts()).toEqual(before);
    expect(
      (await refusalOf(await send("POST", path("/enable"), { cookie: owner })))
        .reason,
    ).toBe("not_tested");
  });

  test("a test brought back without the owner's session is refused and unlocks nothing", async () => {
    const refused = await runTest(alice, "");
    expect(refused.status).toBe(401);
    expect(
      (await refusalOf(await send("POST", path("/enable"), { cookie: owner })))
        .reason,
    ).toBe("not_tested");
  });

  test("a setting changed while the test is at the provider keeps the pass from being written down", async () => {
    const started = await send("POST", path("/test/start"), { cookie: owner });
    const flowCookie = cookieOf(started, LOGIN_FLOW_COOKIE_NAME);
    const { authorization_url } = startProviderLoginResponseSchema.parse(
      await started.json(),
    );
    const back = await idp.authorize(authorization_url, alice);
    await providerOf(
      await send("PATCH", path(), {
        cookie: owner,
        ifMatch: provider.revision,
        body: { allowed_domains: ["example.com"] },
      }),
    );
    const late = await send("POST", "/v1/auth/oidc/callback", {
      cookie: `${flowCookie}; ${owner}`,
      body: { provider_id: provider.id, ...back },
    });
    expect(late.status).toBe(200);
    expect((await late.json()).test).toEqual({
      passed: false,
      reason: "config_changed",
    });
    expect(
      (await refusalOf(await send("POST", path("/enable"), { cookie: owner })))
        .reason,
    ).toBe("not_tested");
  });

  test("a test that passes makes no account and no session, and lets the provider be turned on", async () => {
    const before = await counts();
    const passed = await runTest();
    expect(passed.status).toBe(200);
    expect(cookieOf(passed, WEB_SESSION_COOKIE_NAME)).toBe("");
    expect(
      providerLoginCallbackResponseSchema.parse(await passed.json()),
    ).toEqual({
      outcome: "tested",
      provider_id: provider.id,
      test: {
        passed: true,
        recorded: true,
        subject: "1001",
        email: "alice@example.com",
        email_verified: true,
        address_owned: true,
        // No invite and no joining by itself yet.
        entry: "invite_only",
      },
    });
    expect(await counts()).toEqual(before);

    const listed = listLoginProvidersResponseSchema.parse(
      await (await send("GET", BASE, { cookie: owner })).json(),
    );
    expect(listed.providers[0]?.state).toBe("ready");
    expect(listed.providers[0]?.tested_at).not.toBeNull();

    await providerOf(await send("POST", path("/enable"), { cookie: owner }));
    expect(provider.state).toBe("enabled");
    const methods = loginMethodsResponseSchema.parse(
      await (await send("GET", "/v1/auth/login-methods")).json(),
    );
    expect(methods.providers).toEqual([
      { id: provider.id, display_name: "Keycloak" },
    ]);
  });

  let member = "";
  test("while it is on, who may come in can change and how it connects cannot", async () => {
    for (const body of [
      { client_id: "another-client" },
      { token_auth_method: "client_secret_basic" },
    ]) {
      expect(
        await refusalOf(
          await send("PATCH", path(), {
            cookie: owner,
            ifMatch: provider.revision,
            body,
          }),
        ),
      ).toEqual({
        status: 409,
        code: "REVISION_CONFLICT",
        reason: "provider_enabled",
      });
    }
    expect(
      (
        await refusalOf(
          await send("POST", path("/refresh-discovery"), { cookie: owner }),
        )
      ).reason,
    ).toBe("provider_enabled");
    expect(
      (await refusalOf(await send("DELETE", path(), { cookie: owner }))).reason,
    ).toBe("provider_enabled");

    await providerOf(
      await send("PATCH", path(), {
        cookie: owner,
        ifMatch: provider.revision,
        body: { display_name: "Acme SSO", jit_role: "member" },
      }),
    );
    expect(provider).toMatchObject({
      display_name: "Acme SSO",
      jit_role: "member",
      state: "enabled",
    });

    // Applied at once: alice now joins by herself.
    const joined = await signIn(alice);
    expect(joined.status).toBe(200);
    member = cookieOf(joined, WEB_SESSION_COOKIE_NAME);
    expect(member).not.toBe("");
  });

  test("someone who is not the owner is refused by every route", async () => {
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", BASE],
      ["POST", `${BASE}/discover`, { issuer: idp.issuer }],
      ["POST", BASE, { display_name: "Mine", issuer: `${idp.issuer}/x` }],
      ["PATCH", path(), { display_name: "Mine" }],
      ["POST", path("/refresh-discovery")],
      ["PUT", path("/client-secret"), { value: "a-members-secret" }],
      ["POST", path("/test/start")],
      ["POST", path("/enable")],
      ["POST", path("/disable")],
      ["DELETE", path()],
    ];
    const before = await operations();
    for (const [method, target, body] of attempts) {
      const response = await send(method, target, {
        cookie: member,
        body,
        ifMatch: provider.revision,
      });
      expect(response.status, `${method} ${target}`).toBe(403);
      expect(cookieOf(response, LOGIN_FLOW_COOKIE_NAME)).toBe("");
    }
    expect(await operations()).toEqual(before);
    expect((await send("GET", "/v1/auth/me", { cookie: member })).status).toBe(
      200,
    );
  });

  test("a new secret for a provider that is on waits for a test; sign-ins keep the one that works", async () => {
    await providerOf(
      await send("PUT", path("/client-secret"), {
        cookie: owner,
        body: { value: WRONG_SECRET },
      }),
    );
    expect(provider.state).toBe("enabled_secret_pending");
    expect(provider.client_secret?.last4).toBe(CLIENT_SECRET.slice(-4));
    expect(provider.pending_client_secret?.last4).toBe(WRONG_SECRET.slice(-4));

    // The replacement is the one a test tries, and the provider refuses it.
    const failed = await runTest();
    expect((await failed.json()).test).toEqual({
      passed: false,
      reason: "code_refused",
    });
    // Sign-ins never saw it.
    expect((await signIn(alice)).status).toBe(200);

    // A replacement the provider takes passes and becomes the secret.
    await providerOf(
      await send("PUT", path("/client-secret"), {
        cookie: owner,
        body: { value: CLIENT_SECRET },
      }),
    );
    expect(provider.state).toBe("enabled_secret_pending");
    const passed = await runTest();
    expect((await passed.json()).test).toMatchObject({
      passed: true,
      recorded: true,
      entry: "signs_in",
    });
    const [after] = listLoginProvidersResponseSchema.parse(
      await (await send("GET", BASE, { cookie: owner })).json(),
    ).providers;
    expect(after).toMatchObject({
      state: "enabled",
      pending_client_secret: null,
    });
    expect(after?.client_secret?.last4).toBe(CLIENT_SECRET.slice(-4));
    expect((await signIn(alice)).status).toBe(200);
    if (after) provider = after;
  });

  test("turning it off ends the sessions made through it, and only those", async () => {
    const off = await send("POST", path("/disable"), { cookie: owner });
    expect(off.status).toBe(200);
    const body = disableLoginProviderResponseSchema.parse(await off.json());
    // alice signed in three times above.
    expect(body.sessions_revoked).toBe(3);
    expect(body.provider.state).toBe("ready");
    provider = body.provider;

    expect((await send("GET", "/v1/auth/me", { cookie: member })).status).toBe(
      401,
    );
    expect((await send("GET", "/v1/auth/me", { cookie: owner })).status).toBe(
      200,
    );
    expect((await signIn(alice)).status).toBe(404);

    // Off already: nothing more to end, and nothing more written down.
    const before = await operations();
    const again = disableLoginProviderResponseSchema.parse(
      await (await send("POST", path("/disable"), { cookie: owner })).json(),
    );
    expect(again.sessions_revoked).toBe(0);
    expect(await operations()).toEqual(before);
  });

  test("discovery can be read again while it is off, and then it needs a new test", async () => {
    await providerOf(
      await send("POST", path("/refresh-discovery"), { cookie: owner }),
    );
    expect(provider.state).toBe("needs_test");
    expect(
      (await refusalOf(await send("POST", path("/enable"), { cookie: owner })))
        .reason,
    ).toBe("not_tested");
  });

  test("a provider that is off is deleted with its secret; the people who came through it stay", async () => {
    expect((await send("DELETE", path(), { cookie: owner })).status).toBe(204);
    expect(await db.select().from(secretValues)).toEqual([]);
    expect((await send("DELETE", path(), { cookie: owner })).status).toBe(404);
    expect(
      listLoginProvidersResponseSchema.parse(
        await (await send("GET", BASE, { cookie: owner })).json(),
      ).providers,
    ).toEqual([]);
    const kept = await db.select().from(loginMethods);
    expect(kept.filter((method) => method.issuer === idp.issuer)).toHaveLength(
      1,
    );
  });

  test("every change left a receipt, in order, by the owner, with no secret in it", async () => {
    const rows = await db
      .select()
      .from(receipts)
      .where(like(receipts.operation, "%login_provider%"))
      .orderBy(receipts.createdAt);
    expect(rows.map((row) => row.operation)).toEqual([
      "create_login_provider",
      // Client ID and client authentication.
      "update_login_provider",
      "set_login_provider_secret",
      // Allowed domains, while a test was at the provider.
      "update_login_provider",
      "test_login_provider",
      "enable_login_provider",
      // Name and joining role, while on.
      "update_login_provider",
      "set_login_provider_secret",
      "set_login_provider_secret",
      "test_login_provider",
      "disable_login_provider",
      "refresh_login_provider_discovery",
      "delete_login_provider",
    ]);
    for (const row of rows) {
      expect(row.ownerId).toBe(workspaceId);
      expect(row.actor).toMatchObject({
        actor_user_id: ownerId,
        principal: { kind: "user", id: ownerId },
      });
    }
    const written = JSON.stringify(rows);
    expect(written).not.toContain(CLIENT_SECRET);
    expect(written).not.toContain(WRONG_SECRET);
  });
});
