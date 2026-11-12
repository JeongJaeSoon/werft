import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  loginMethodsResponseSchema,
  providerLoginCallbackResponseSchema,
  startProviderLoginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresLoginProviderStore,
  disableLoginProvider,
  invites,
  loginMethods,
  loginProviders,
  memberships,
  receipts,
  users,
  webSessions,
} from "@werft-ai/db";
import { seedLoginProvider } from "@werft-ai/db/testing/login-provider";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { derivedSecretKey, SecretKey } from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashWebSessionToken,
  LoginLockout,
} from "./auth.ts";
import { GOOGLE_ISSUER } from "./oidc/index.ts";
import { createProviderLogin } from "./provider-login.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "bootstrap-token-for-provider-login-tests";
const PASSWORD = "correct horse battery staple";
const CLIENT_ID = "client-id.apps.example";
const CLIENT_SECRET = "mock-provider-client-secret";
const KEY = SecretKey.fromHex("ab".repeat(32), "test");
const BROWSER = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const REJECTED = { code: "UNAUTHORIZED", message: "Sign-in was not accepted" };

type Settings = {
  allowedDomains?: string[];
  jitRole?: "member" | null;
  requireVerifiedEmail?: boolean;
};

integration("provider sign-in first-entry rules on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let identity: DatabaseIdentityStore;
  // Two stand-in providers: one names itself Google, so Google's own rules
  // about who owns an address apply to it; the other is any OIDC provider.
  let googleIdp: MockOidcServer;
  let otherIdp: MockOidcServer;
  let googleId = "";
  let otherId = "";
  let workspaceId = "";
  let ownerId = "";

  function appFor(providerId: string, idp: MockOidcServer) {
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
      providers: createProviderLogin({
        providers: createPostgresLoginProviderStore(db, KEY),
        // On loopback, so the stand-in providers' plain http is allowed.
        consoleOrigin: "http://localhost:5173",
        flowKey: derivedSecretKey(KEY, "login-flow-cookie"),
      }),
    };
    const app = createApiApp({
      authMode: "api-key",
      keyStore: { find: async () => null },
      identity,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => registerAuthRoutes(router, auth),
    });
    const post = (
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...BROWSER, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    /** The start request and the provider's answer, not yet brought back. */
    const begin = async (claims: MockOidcClaims) => {
      const started = await post(`/v1/auth/providers/${providerId}/start`);
      expect(started.status).toBe(200);
      const flowCookie =
        (started.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      const { authorization_url } = startProviderLoginResponseSchema.parse(
        await started.json(),
      );
      const back = await idp.authorize(authorization_url, claims);
      return () =>
        post(
          "/v1/auth/oidc/callback",
          { provider_id: providerId, ...back },
          { Cookie: flowCookie },
        );
    };
    const signIn = async (claims: MockOidcClaims) => (await begin(claims))();
    return { app, post, begin, signIn };
  }

  /**
   * The provider's settings as an owner would leave them, before a sign-in
   * starts. What a setting is not given goes back to its default.
   */
  async function configure(providerId: string, settings: Settings = {}) {
    await db
      .update(loginProviders)
      .set({
        allowedDomains: settings.allowedDomains ?? [],
        jitRole: settings.jitRole ?? null,
        requireVerifiedEmail: settings.requireVerifiedEmail ?? true,
        enabled: true,
      })
      .where(eq(loginProviders.id, providerId));
  }
  const google = async (settings: Settings = {}) => {
    await configure(googleId, settings);
    return appFor(googleId, googleIdp);
  };
  const other = async (settings: Settings = {}) => {
    await configure(otherId, settings);
    return appFor(otherId, otherIdp);
  };

  const sessionCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))
      ?.split(";")[0] ?? "";
  const errorOf = async (response: Response) => {
    const { error } = await response.json();
    return { code: error.code, message: error.message };
  };
  const signedInBody = async (response: Response) =>
    providerLoginCallbackResponseSchema.parse(await response.json());
  const methodsOf = (userId: string) =>
    db.select().from(loginMethods).where(eq(loginMethods.userId, userId));
  const userByEmail = async (email: string) =>
    (await db.select().from(users).where(eq(users.email, email)))[0];
  const invite = async (email: string, role = "member", ttlMs = 60_000) => {
    const id = randomUUID();
    await db.insert(invites).values({
      id,
      workspaceId,
      email,
      role,
      tokenHash: hashWebSessionToken(randomUUID()),
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return id;
  };
  const meStatus = async (
    app: ReturnType<typeof appFor>["app"],
    cookie: string,
  ) =>
    (await app.request("/v1/auth/me", { headers: { Cookie: cookie } })).status;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "provider_login" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    identity = new DatabaseIdentityStore(db);
    googleIdp = await startMockOidcServer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      issuer: GOOGLE_ISSUER,
    });
    otherIdp = await startMockOidcServer({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    // A client secret is stored under a workspace, so the owner comes first.
    const created = await appFor(randomUUID(), otherIdp).post(
      "/v1/auth/bootstrap",
      {
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    );
    expect(created.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await created.json());
    workspaceId = body.workspace.id;
    ownerId = body.user_id;

    const stored = { key: KEY, value: CLIENT_SECRET };
    const googleAt = `http://127.0.0.1:${googleIdp.port}`;
    googleId = (
      await seedLoginProvider(
        db,
        {
          displayName: "Google",
          issuer: GOOGLE_ISSUER,
          authorizationEndpoint: `${googleAt}/authorize`,
          tokenEndpoint: `${googleAt}/token`,
          jwksUri: `${googleAt}/jwks`,
          clientId: CLIENT_ID,
          tokenAuthMethod: "client_secret_post",
          createdBy: ownerId,
        },
        stored,
      )
    ).id;
    otherId = (
      await seedLoginProvider(
        db,
        {
          displayName: "Keycloak",
          issuer: otherIdp.issuer,
          clientId: CLIENT_ID,
          tokenAuthMethod: "client_secret_post",
          createdBy: ownerId,
        },
        stored,
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    googleIdp?.stop();
    otherIdp?.stop();
    await pool?.end();
    await database?.drop();
  });

  test("bootstrap gives the owner a kind=password login method", async () => {
    const methods = await methodsOf(ownerId);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({
      kind: "password",
      issuer: null,
      subject: null,
    });
  });

  test("the login page is offered both providers, in the order they were added", async () => {
    const { app } = await google();
    expect(
      loginMethodsResponseSchema.parse(
        await (await app.request("/v1/auth/login-methods")).json(),
      ),
    ).toEqual({
      password: "on",
      providers: [
        { id: googleId, display_name: "Google" },
        { id: otherId, display_name: "Keycloak" },
      ],
    });
  });

  test("rule 2: a live invite creates a passwordless account, accepts the invite and signs in", async () => {
    const inviteId = await invite("bob@example.com", "owner");
    const { app, signIn } = await google();
    const response = await signIn({
      sub: "sub-bob",
      email: "Bob@Example.com",
      hd: "example.com",
      name: "Bob",
    });
    expect(response.status).toBe(200);
    const body = await signedInBody(response);
    expect(body).toMatchObject({ workspace_id: workspaceId, role: "owner" });
    const bob = await userByEmail("bob@example.com");
    expect(bob).toMatchObject({
      id: body.user_id,
      passwordHash: null,
      displayName: "Bob",
    });
    const methods = await methodsOf(body.user_id);
    expect(methods).toMatchObject([
      {
        kind: "oidc",
        issuer: GOOGLE_ISSUER,
        subject: "sub-bob",
        emailAtLink: "bob@example.com",
      },
    ]);
    const [accepted] = await db
      .select()
      .from(invites)
      .where(eq(invites.id, inviteId));
    expect(accepted?.acceptedAt).not.toBeNull();
    // The receipt of the acceptance names the provider that vouched.
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "accept_invite"));
    expect(receipt?.result).toMatchObject({
      login_method: "oidc",
      issuer: GOOGLE_ISSUER,
    });

    const cookie = sessionCookie(response);
    const me = await app.request("/v1/auth/me", {
      headers: { Cookie: cookie },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("bob@example.com");
    // The session is the login method's, so turning the provider off finds it.
    const [session] = await db
      .select({ loginMethodId: webSessions.loginMethodId })
      .from(webSessions)
      .where(eq(webSessions.userId, body.user_id));
    expect(session?.loginMethodId).toBe(methods[0]?.id as string);
  });

  test("rule 2: an expired or revoked invite admits nobody", async () => {
    await invite("late@example.com", "member", -1_000);
    const response = await (await google()).signIn({
      sub: "sub-late",
      email: "late@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(401);
    expect(await userByEmail("late@example.com")).toBeUndefined();
  });

  test("rule 1: a linked account signs in as its user, whatever address the provider now reports", async () => {
    const bob = await userByEmail("bob@example.com");
    const response = await (await google()).signIn({
      sub: "sub-bob",
      email: "bob.renamed@example.com",
    });
    expect(response.status).toBe(200);
    const body = await signedInBody(response);
    expect(body.user_id).toBe(bob?.id as string);
    expect(await db.$count(users)).toBe(2);
    const [method] = await methodsOf(body.user_id);
    expect(method?.lastLoginAt).not.toBeNull();
  });

  test("rule 1: a linked account of a disabled user is refused like an unknown one", async () => {
    await invite("carol@example.com");
    const { signIn } = await google();
    expect(
      (
        await signIn({
          sub: "sub-carol",
          email: "carol@example.com",
          hd: "example.com",
        })
      ).status,
    ).toBe(200);
    await db
      .update(users)
      .set({ disabledAt: sql`now()` })
      .where(eq(users.email, "carol@example.com"));
    const response = await signIn({
      sub: "sub-carol",
      email: "carol@example.com",
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual(REJECTED);
  });

  test("rule 3: JIT admits an allowed domain as a member of the workspace", async () => {
    const response = await (
      await google({ allowedDomains: ["example.com"], jitRole: "member" })
    ).signIn({
      sub: "sub-dave",
      email: "dave@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(200);
    const body = await signedInBody(response);
    expect(body).toMatchObject({ workspace_id: workspaceId, role: "member" });
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, body.user_id));
    expect(membership?.role).toBe("member");
  });

  test("rule 3: with JIT off the same account is refused", async () => {
    const response = await (
      await google({ allowedDomains: ["example.com"] })
    ).signIn({
      sub: "sub-erin",
      email: "erin@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(401);
    expect(await userByEmail("erin@example.com")).toBeUndefined();
  });

  test("rule 3: Google with no allowed domain lets nobody join by themselves", async () => {
    const response = await (await google({ jitRole: "member" })).signIn({
      sub: "sub-zed",
      email: "zed@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(401);
    expect(await userByEmail("zed@example.com")).toBeUndefined();
  });

  test("rule 4: an address that has an account is never joined by email, invite or JIT notwithstanding", async () => {
    await invite("owner@example.com");
    const sessionsBefore = await db.$count(webSessions);
    const response = await (
      await google({ allowedDomains: ["example.com"], jitRole: "member" })
    ).signIn({
      sub: "sub-impostor",
      email: "owner@example.com",
      hd: "example.com",
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({
      code: "LOGIN_LINK_REQUIRED",
      message:
        "Sign in with your existing account, then connect this provider in settings",
    });
    expect(sessionCookie(response)).toBe("");
    expect(await db.$count(webSessions)).toBe(sessionsBefore);
    expect(await methodsOf(ownerId)).toHaveLength(1);
    expect(
      await db.$count(loginMethods, eq(loginMethods.subject, "sub-impostor")),
    ).toBe(0);
  });

  test("rule 5: refusals read the same whether or not an account exists", async () => {
    const { signIn } = await google();
    const unknown = await signIn({
      sub: "sub-nobody",
      email: "nobody@example.com",
    });
    const disabled = await signIn({
      sub: "sub-carol",
      email: "carol@example.com",
    });
    const unverified = await signIn({
      sub: "sub-x",
      email: "owner@example.com",
      email_verified: false,
    });
    for (const response of [unknown, disabled, unverified]) {
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toEqual(REJECTED);
    }
    expect(await userByEmail("nobody@example.com")).toBeUndefined();
  });

  test("a domain restriction admits only accounts Google places in that domain", async () => {
    const restricted = await google({ allowedDomains: ["example.com"] });
    for (const claims of [
      { sub: "sub-bob", email: "bob@example.com", hd: "other.example" },
      { sub: "sub-bob", email: "bob@example.com" },
    ]) {
      const response = await restricted.signIn(claims);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "FORBIDDEN" },
      });
    }
    expect(
      (
        await restricted.signIn({
          sub: "sub-bob",
          email: "bob@example.com",
          hd: "example.com",
        })
      ).status,
    ).toBe(200);
  });

  test("password login of a passwordless account fails exactly like a wrong password", async () => {
    const { post } = await google();
    const passwordless = await post("/v1/auth/login", {
      email: "bob@example.com",
      password: PASSWORD,
    });
    const wrong = await post("/v1/auth/login", {
      email: "owner@example.com",
      password: "not the owner's password",
    });
    expect(passwordless.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await errorOf(passwordless)).toEqual(await errorOf(wrong));
    expect(sessionCookie(passwordless)).toBe("");
  });

  test("an owner cannot issue a reset link for a passwordless account", async () => {
    const { app, post } = await google();
    const login = await post("/v1/auth/login", {
      email: "owner@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const bob = await userByEmail("bob@example.com");
    const response = await app.request(
      `/v1/workspaces/${workspaceId}/members/${bob?.id}/password-reset`,
      {
        method: "POST",
        headers: {
          ...BROWSER,
          "Content-Type": "application/json",
          Cookie: sessionCookie(login),
        },
        body: JSON.stringify({ current_password: PASSWORD }),
      },
    );
    expect(response.status).toBe(404);
  });

  test("rule 2: only an address Google still vouches for (its Workspace domain or gmail.com) takes an invite", async () => {
    await invite("ivy@example.com");
    const { signIn } = await google();
    const stale = await signIn({ sub: "sub-ivy", email: "ivy@example.com" });
    expect(stale.status).toBe(401);
    expect(await userByEmail("ivy@example.com")).toBeUndefined();
    const elsewhere = await signIn({
      sub: "sub-ivy",
      email: "ivy@example.com",
      hd: "other.example",
    });
    expect(elsewhere.status).toBe(401);
    await invite("gina@gmail.com");
    expect(
      (await signIn({ sub: "sub-gina", email: "gina@gmail.com" })).status,
    ).toBe(200);
  });

  test("an address Google does not vouch for learns nothing about the account that has it", async () => {
    const response = await (await google()).signIn({
      sub: "sub-former-owner",
      email: "owner@example.com",
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual(REJECTED);
  });

  test("an invite that expires while another transaction holds it admits nobody", async () => {
    const inviteId = await invite("jo@example.com", "member", 300);
    const { signIn } = await google();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
        inviteId,
      ]);
      const pending = signIn({
        sub: "sub-jo",
        email: "jo@example.com",
        hd: "example.com",
      });
      await Bun.sleep(600);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(401);
    } finally {
      holder.release();
    }
    expect(await userByEmail("jo@example.com")).toBeUndefined();
  });

  test("two accounts of one provider claiming one address at once make one account", async () => {
    const { signIn } = await google({
      allowedDomains: ["example.com"],
      jitRole: "member",
    });
    const responses = await Promise.all(
      ["sub-kim-1", "sub-kim-2"].map((sub) =>
        signIn({ sub, email: "kim@example.com", hd: "example.com" }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  test("two first logins of one account at once make one account", async () => {
    await invite("frank@example.com");
    const frank = {
      sub: "sub-frank",
      email: "frank@example.com",
      hd: "example.com",
    };
    const { signIn } = await google();
    const responses = await Promise.all([signIn(frank), signIn(frank)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const ids = await Promise.all(responses.map(signedInBody));
    expect(ids[0]?.user_id).toBe(ids[1]?.user_id as string);
    expect(
      await db.$count(
        loginMethods,
        and(
          eq(loginMethods.kind, "oidc"),
          eq(loginMethods.subject, "sub-frank"),
        ),
      ),
    ).toBe(1);
  });

  test("any other provider: a verified address takes an invite or joins by JIT, with no hosted domain", async () => {
    await invite("hana@corp.example", "admin");
    const invited = await (await other()).signIn({
      sub: "kc-hana",
      email: "hana@corp.example",
      name: "Hana",
    });
    expect(invited.status).toBe(200);
    expect(await signedInBody(invited)).toMatchObject({ role: "admin" });
    expect(
      await methodsOf((await userByEmail("hana@corp.example"))?.id as string),
    ).toMatchObject([
      { kind: "oidc", issuer: otherIdp.issuer, subject: "kc-hana" },
    ]);

    const joined = await (await other({ jitRole: "member" })).signIn({
      sub: "kc-ian",
      email: "ian@corp.example",
    });
    expect(joined.status).toBe(200);
    expect(await signedInBody(joined)).toMatchObject({ role: "member" });
  });

  test("any other provider: an address it does not mark verified takes no invite and does not join", async () => {
    await invite("june@corp.example");
    const { signIn } = await other({
      jitRole: "member",
      requireVerifiedEmail: false,
    });
    const response = await signIn({
      sub: "kc-june",
      email: "june@corp.example",
      email_verified: null,
    });
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toEqual(REJECTED);
    expect(await userByEmail("june@corp.example")).toBeUndefined();
  });

  test("the same subject at another issuer is another person, and the same address is never joined across issuers", async () => {
    // sub-bob is Bob at Google; at the other provider it is nobody yet.
    const stranger = await (await other()).signIn({
      sub: "sub-bob",
      email: "someone-new@corp.example",
    });
    expect(stranger.status).toBe(401);

    const bob = await userByEmail("bob@example.com");
    const sameAddress = await (await other({ jitRole: "member" })).signIn({
      sub: "kc-bob",
      email: "bob@example.com",
    });
    expect(sameAddress.status).toBe(409);
    expect((await errorOf(sameAddress)).code).toBe("LOGIN_LINK_REQUIRED");
    expect(sessionCookie(sameAddress)).toBe("");
    expect(await methodsOf(bob?.id as string)).toMatchObject([
      { issuer: GOOGLE_ISSUER, subject: "sub-bob" },
    ]);
  });

  test("turning a provider off ends its sessions at once and refuses its sign-ins; the rest stay", async () => {
    const { app, post, signIn, begin } = await other();
    const hana = await signIn({ sub: "kc-hana", email: "hana@corp.example" });
    const hanaCookie = sessionCookie(hana);
    const bob = await (await google()).signIn({
      sub: "sub-bob",
      email: "bob@example.com",
    });
    const bobCookie = sessionCookie(bob);
    const owner = await post("/v1/auth/login", {
      email: "owner@example.com",
      password: PASSWORD,
    });
    const ownerCookie = sessionCookie(owner);
    for (const cookie of [hanaCookie, bobCookie, ownerCookie]) {
      expect(await meStatus(app, cookie)).toBe(200);
    }
    // In flight: the provider has answered, the browser is on its way back.
    const inFlight = await begin({
      sub: "kc-hana",
      email: "hana@corp.example",
    });

    const off = await disableLoginProvider(db, otherId);
    expect(off?.sessionsRevoked).toBeGreaterThanOrEqual(1);

    expect(await meStatus(app, hanaCookie)).toBe(401);
    expect(await meStatus(app, bobCookie)).toBe(200);
    expect(await meStatus(app, ownerCookie)).toBe(200);

    const sessionsBefore = await db.$count(webSessions);
    const late = await inFlight();
    expect(late.status).toBe(404);
    expect(sessionCookie(late)).toBe("");
    expect((await post(`/v1/auth/providers/${otherId}/start`)).status).toBe(
      404,
    );
    expect(await db.$count(webSessions)).toBe(sessionsBefore);
    expect(
      loginMethodsResponseSchema.parse(
        await (await app.request("/v1/auth/login-methods")).json(),
      ).providers,
    ).toEqual([{ id: googleId, display_name: "Google" }]);
  });

  test("a sign-in started before the provider's settings changed is refused", async () => {
    const { begin, signIn } = await google();
    const finish = await begin({ sub: "sub-bob", email: "bob@example.com" });
    await db
      .update(loginProviders)
      .set({ configRevision: sql`${loginProviders.configRevision} + 1` })
      .where(eq(loginProviders.id, googleId));
    const stale = await finish();
    expect(stale.status).toBe(401);
    expect(await errorOf(stale)).toEqual(REJECTED);
    expect(sessionCookie(stale)).toBe("");
    // Starting again reads the settings as they are now.
    expect(
      (await signIn({ sub: "sub-bob", email: "bob@example.com" })).status,
    ).toBe(200);
  });
});
