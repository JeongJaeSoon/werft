import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LOGIN_FLOW_COOKIE_NAME,
  LOGIN_LINK_SESSION_MAX_AGE_MINUTES,
  listMyLoginMethodsResponseSchema,
  startProviderLoginResponseSchema,
  unlinkMyLoginMethodResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import type {
  ExternalSignInResult,
  IdentityStore,
  LoginMethodStore,
  LoginProvider,
  LoginProviderStore,
  ResolvedWebSession,
  UnlinkLoginMethodInput,
} from "@werft-ai/platform";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { createBootstrapGate, hashWebSessionToken, WorkGate } from "./auth.ts";
import { generateApiKey, hashApiKey } from "./keys.ts";
import { createFlowSealer } from "./oidc/flow-cookie.ts";
import { createProviderLogin } from "./provider-login.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";

// The routes of an invite's sign-up and of a person's own ways to sign in,
// over stores that answer what each test says. What the database does with
// them is in login-methods.integration.test.ts.

const createApiApp = recordRouteErrors("login-methods.test.ts");

// Made per run: nothing here is a value anyone could use elsewhere.
const made = () => randomBytes(18).toString("base64url");
const CLIENT_ID = "client-id.apps.example";
const CLIENT_KEY = made();
// On loopback, so the stand-in provider's plain http is allowed.
const CONSOLE_ORIGIN = "http://localhost:5173";
const PROVIDER_ID = randomUUID();
const INVITE_ID = randomUUID();
const FLOW_KEY = randomBytes(32);
const API_KEY = generateApiKey();
const BROWSER = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
const sealer = createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME);

let idp: MockOidcServer;
beforeAll(async () => {
  idp = await startMockOidcServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_KEY,
  });
});
afterAll(() => idp.stop());

const alice: MockOidcClaims = {
  sub: "1001",
  email: "alice@example.com",
  name: "Alice",
};

const person = (): ResolvedWebSession => ({
  sessionId: randomUUID(),
  userId: randomUUID(),
  email: "alice@example.com",
  displayName: "Alice",
  locale: null,
  workspaceId: randomUUID(),
  role: "member",
  expiresAt: new Date(Date.now() + 60_000),
});

/** What a query answers with while the database cannot be reached. */
const outage = () =>
  Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

function harness(
  options: {
    /** Null: the session cookie of a request is nobody's. */
    session?: ResolvedWebSession | null;
    methods?: Partial<LoginMethodStore>;
    consoleOrigin?: string | null;
    providerWork?: WorkGate;
  } = {},
) {
  const session = options.session === undefined ? person() : options.session;
  const state = { sessionReadFails: false, providerReads: 0 };
  const signedIn: ExternalSignInResult = {
    outcome: "signed_in",
    via: "linked",
    userId: randomUUID(),
    workspaceId: randomUUID(),
    role: "member",
    expiresAt: new Date(Date.now() + 60_000),
  };
  const identity = {
    resolveWebSession: async () => {
      if (state.sessionReadFails) throw outage();
      return session;
    },
    renewWebSession: async () => null,
    signInWithExternalIdentity: async () => signedIn,
  } as unknown as IdentityStore;
  const row: LoginProvider = {
    id: PROVIDER_ID,
    displayName: "Mock",
    issuer: idp.issuer,
    authorizationEndpoint: `${idp.issuer}/authorize`,
    tokenEndpoint: `${idp.issuer}/token`,
    jwksUri: `${idp.issuer}/jwks`,
    userinfoEndpoint: null,
    signingAlgs: ["RS256"],
    issParameterRequired: false,
    clientId: CLIENT_ID,
    tokenAuthMethod: "client_secret_post",
    allowedDomains: [],
    jitRole: null,
    requireVerifiedEmail: true,
    enabled: true,
    configRevision: 1,
  };
  const store: LoginProviderStore = {
    listEnabled: async () => [row],
    findForSignIn: async (id) => {
      state.providerReads += 1;
      return id === row.id
        ? { provider: { ...row }, clientSecret: CLIENT_KEY }
        : null;
    },
  };
  const unlinks: UnlinkLoginMethodInput[] = [];
  const notReached = async () => {
    throw new Error("not reached by these tests");
  };
  const methods: LoginMethodStore = {
    inviteForSignUp: async () => ({ outcome: "pending", inviteId: INVITE_ID }),
    signUpWithInvite: notReached,
    sessionIsFresh: async () => true,
    link: notReached,
    list: async () => ({ methods: [], linkable: [] }),
    unlink: async (input) => {
      unlinks.push(input);
      return { outcome: "unlinked", sessionsRevoked: 2 };
    },
    ...options.methods,
  };
  const auth = {
    identity,
    bootstrap: createBootstrapGate(made()),
    providers: createProviderLogin({
      providers: store,
      consoleOrigin:
        options.consoleOrigin === undefined
          ? CONSOLE_ORIGIN
          : options.consoleOrigin,
      flowKey: FLOW_KEY,
    }),
    loginMethods: methods,
    ...(options.providerWork ? { providerWork: options.providerWork } : {}),
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore: {
      find: async (hash) =>
        Buffer.from(hash).equals(Buffer.from(hashApiKey(API_KEY)))
          ? {
              id: "key-id",
              ownerId: "key-owner",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: ["sessions:read" as const],
            }
          : null,
    },
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) => registerAuthRoutes(router, auth),
  });
  const sessionCookie = `${WEB_SESSION_COOKIE_NAME}=${made()}`;
  type Init = {
    body?: unknown;
    cookies?: string[];
    headers?: Record<string, string>;
  };
  /** A request from the console, with no session cookie. */
  const request = (method: string, path: string, init: Init = {}) =>
    app.request(path, {
      method,
      headers: {
        ...BROWSER,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(init.cookies?.length ? { Cookie: init.cookies.join("; ") } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  /** The same from the signed-in person's browser. */
  const mine = (method: string, path: string, init: Init = {}) =>
    request(method, path, {
      ...init,
      cookies: [sessionCookie, ...(init.cookies ?? [])],
    });
  const withKey = (method: string, path: string) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  return { request, mine, withKey, session, state, unlinks, sessionCookie };
}

const inviteStart = (id: string = PROVIDER_ID) =>
  `/v1/auth/providers/${id}/invite/start`;
const MINE = "/v1/auth/me/login-methods";
const linkStart = (id: string = PROVIDER_ID) => `${MINE}/${id}/link/start`;

/** The flow cookie a response set, as a request sends it back; "" for none. */
function flowCookieOf(response: Response): string {
  const set = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .find((cookie) => cookie.startsWith(`${LOGIN_FLOW_COOKIE_NAME}=`));
  return set && set !== `${LOGIN_FLOW_COOKIE_NAME}=` ? set : "";
}
const flowOf = (response: Response) =>
  sealer.open(flowCookieOf(response).split("=").slice(1).join("="));

const errorOf = async (response: Response) => {
  const { error } = await response.json();
  return { code: error.code, message: error.message, details: error.details };
};

describe("a sign-up by invite starts at a provider", () => {
  test("a pending invite starts a flow sealed with that invite", async () => {
    const hashes: Uint8Array[] = [];
    const h = harness({
      // Nobody is signed in when an invite is redeemed.
      session: null,
      methods: {
        inviteForSignUp: async (hash) => {
          hashes.push(hash);
          return { outcome: "pending", inviteId: INVITE_ID };
        },
      },
    });
    const word = made();
    const started = await h.request("POST", inviteStart(), {
      body: { invite_token: word },
    });
    expect(started.status).toBe(200);
    expect(started.headers.get("Cache-Control")).toBe("no-store");
    const { authorization_url } = startProviderLoginResponseSchema.parse(
      await started.json(),
    );
    expect(authorization_url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    // The invite is found by the hash, and the token goes nowhere else.
    expect(hashes.map((hash) => Buffer.from(hash).toString("hex"))).toEqual([
      Buffer.from(hashWebSessionToken(word)).toString("hex"),
    ]);
    expect(authorization_url).not.toContain(word);
    const flow = flowOf(started);
    expect(flow).toMatchObject({
      purpose: "invite",
      providerId: PROVIDER_ID,
      invite: { inviteId: INVITE_ID },
    });
    expect(flow?.link).toBeUndefined();
  });

  test("a used invite answers 409 and a dead or unknown one 410, before any provider is read", async () => {
    for (const [outcome, status, code] of [
      ["used", 409, "INVITE_USED"],
      ["expired", 410, "INVITE_EXPIRED"],
      ["unknown", 410, "INVITE_EXPIRED"],
    ] as const) {
      const h = harness({
        methods: { inviteForSignUp: async () => ({ outcome }) },
      });
      const refused = await h.request("POST", inviteStart(), {
        body: { invite_token: made() },
      });
      expect(refused.status).toBe(status);
      expect((await errorOf(refused)).code).toBe(code);
      expect(flowCookieOf(refused)).toBe("");
      expect(h.state.providerReads).toBe(0);
    }
  });

  test("it is refused off the console, malformed, oversized, for no provider, and while it cannot run", async () => {
    const h = harness();
    const body = { invite_token: made() };
    // Without the header a page of another site cannot send.
    const offSite = await h.request("POST", inviteStart(), {
      body,
      headers: { [CSRF_HEADER_NAME]: "" },
    });
    expect(offSite.status).toBe(403);
    for (const malformed of [
      {},
      { invite_token: 1 },
      { invite_token: "" },
      { ...body, email: "alice@example.com" },
    ]) {
      const refused = await h.request("POST", inviteStart(), {
        body: malformed,
      });
      expect(refused.status).toBe(400);
    }
    const oversized = await h.request("POST", inviteStart(), {
      body: { invite_token: "x".repeat(65 * 1024) },
    });
    expect(oversized.status).toBe(413);
    for (const id of [randomUUID(), "google"]) {
      const none = await h.request("POST", inviteStart(id), { body });
      expect(none.status).toBe(404);
      expect(flowCookieOf(none)).toBe("");
    }
    const unset = await harness({ consoleOrigin: null }).request(
      "POST",
      inviteStart(),
      { body },
    );
    expect(unset.status).toBe(503);
    const down = await harness({
      methods: {
        inviteForSignUp: async () => {
          throw outage();
        },
      },
    }).request("POST", inviteStart(), { body });
    expect(down.status).toBe(503);
    expect((await errorOf(down)).code).toBe("BACKEND_UNAVAILABLE");
  });
});

describe("a person's own ways to sign in", () => {
  test("the list says what is linked, what can be, and whether this session may change it", async () => {
    const methodId = randomUUID();
    const linkedAt = new Date("2026-10-01T09:00:00Z");
    for (const fresh of [true, false]) {
      const asked: unknown[] = [];
      const h = harness({
        methods: {
          list: async (userId) => {
            asked.push(userId);
            return {
              methods: [
                {
                  id: methodId,
                  kind: "oidc",
                  provider: {
                    id: PROVIDER_ID,
                    displayName: "Mock",
                    enabled: false,
                  },
                  issuer: idp.issuer,
                  emailAtLink: null,
                  createdAt: linkedAt,
                  lastLoginAt: null,
                  usable: false,
                },
              ],
              linkable: [{ id: PROVIDER_ID, displayName: "Mock" }],
            };
          },
          sessionIsFresh: async (input) => {
            asked.push(input);
            return fresh;
          },
        },
      });
      const listed = await h.mine("GET", MINE);
      expect(listed.status).toBe(200);
      expect(listed.headers.get("Cache-Control")).toBe("no-store");
      expect(
        listMyLoginMethodsResponseSchema.parse(await listed.json()),
      ).toEqual({
        methods: [
          {
            id: methodId,
            kind: "oidc",
            provider: { id: PROVIDER_ID, display_name: "Mock", enabled: false },
            issuer: idp.issuer,
            email_at_link: null,
            created_at: linkedAt.toISOString(),
            last_login_at: null,
            usable: false,
          },
        ],
        linkable: [{ id: PROVIDER_ID, display_name: "Mock" }],
        can_change: fresh,
      });
      // Both are asked about the person of the session, on the store's clock.
      expect(asked).toContainEqual(h.session?.userId);
      expect(asked).toContainEqual({
        sessionId: h.session?.sessionId,
        userId: h.session?.userId,
        maxAgeMs: LOGIN_LINK_SESSION_MAX_AGE_MINUTES * 60 * 1000,
      });
    }
  });

  test("none of the three is for an API key, or for nobody", async () => {
    const methodPath = `${MINE}/${randomUUID()}`;
    const h = harness();
    for (const [method, path] of [
      ["GET", MINE],
      ["POST", linkStart()],
      ["DELETE", methodPath],
    ] as const) {
      const keyed = await h.withKey(method, path);
      expect(keyed.status).toBe(403);
      expect((await errorOf(keyed)).message).toBe(
        "A user's ways to sign in change from their own session only",
      );
      expect((await h.request(method, path)).status).toBe(401);
    }
    expect(h.unlinks).toHaveLength(0);
    expect(h.state.providerReads).toBe(0);
    const nobody = harness({ session: null });
    expect((await nobody.mine("DELETE", methodPath)).status).toBe(401);
    expect(nobody.unlinks).toHaveLength(0);
  });

  test("a link starts a flow sealed with the person and this session", async () => {
    const h = harness();
    const started = await h.mine("POST", linkStart());
    expect(started.status).toBe(200);
    expect(started.headers.get("Cache-Control")).toBe("no-store");
    startProviderLoginResponseSchema.parse(await started.json());
    const flow = flowOf(started);
    expect(flow).toMatchObject({
      purpose: "link",
      providerId: PROVIDER_ID,
      link: { userId: h.session?.userId, sessionId: h.session?.sessionId },
    });
    expect(flow?.invite).toBeUndefined();
  });

  test("a session left open starts no link and removes nothing", async () => {
    const h = harness({ methods: { sessionIsFresh: async () => false } });
    for (const refused of [
      await h.mine("POST", linkStart()),
      await h.mine("DELETE", `${MINE}/${randomUUID()}`),
    ]) {
      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toMatchObject({
        code: "FORBIDDEN",
        details: { reason_code: "session_too_old" },
      });
      expect(flowCookieOf(refused)).toBe("");
    }
    expect(h.state.providerReads).toBe(0);
    expect(h.unlinks).toHaveLength(0);
  });

  test("a link to no provider is 404, and 503 while the session's age cannot be read", async () => {
    const h = harness();
    for (const id of [randomUUID(), "google"]) {
      const none = await h.mine("POST", linkStart(id));
      expect(none.status).toBe(404);
      expect(flowCookieOf(none)).toBe("");
    }
    const down = harness({
      methods: {
        sessionIsFresh: async () => {
          throw outage();
        },
      },
    });
    for (const refused of [
      await down.mine("GET", MINE),
      await down.mine("POST", linkStart()),
      await down.mine("DELETE", `${MINE}/${randomUUID()}`),
    ]) {
      expect(refused.status).toBe(503);
    }
    expect(down.unlinks).toHaveLength(0);
  });

  test("a removal is asked for this session, and says how many sessions ended", async () => {
    const h = harness();
    const methodId = randomUUID();
    const removed = await h.mine("DELETE", `${MINE}/${methodId}`);
    expect(removed.status).toBe(200);
    const body = unlinkMyLoginMethodResponseSchema.parse(await removed.json());
    expect(body.sessions_revoked).toBe(2);
    expect(h.unlinks).toEqual([
      {
        userId: h.session?.userId as string,
        sessionId: h.session?.sessionId as string,
        maxAgeMs: LOGIN_LINK_SESSION_MAX_AGE_MINUTES * 60 * 1000,
        loginMethodId: methodId,
        workspaceId: h.session?.workspaceId as string,
        receiptId: body.receipt_id,
      },
    ]);
  });

  test("a removal the store refuses answers what was refused", async () => {
    const path = `${MINE}/${randomUUID()}`;
    for (const [outcome, status, expected] of [
      ["not_found", 404, { code: "NOT_FOUND" }],
      [
        "last_method",
        409,
        {
          code: "REVISION_CONFLICT",
          details: { reason_code: "last_login_method" },
        },
      ],
      // The session ended while the request waited behind the user's lock.
      ["session_gone", 401, { code: "UNAUTHORIZED", message: "Sign in again" }],
    ] as const) {
      const h = harness({ methods: { unlink: async () => ({ outcome }) } });
      const refused = await h.mine("DELETE", path);
      expect(refused.status).toBe(status);
      expect(await errorOf(refused)).toMatchObject(expected);
    }
    // An id that is no UUID is nobody's, without a read.
    const h = harness();
    expect((await h.mine("DELETE", `${MINE}/password`)).status).toBe(404);
    expect(h.unlinks).toHaveLength(0);
    const down = harness({
      methods: {
        unlink: async () => {
          throw outage();
        },
      },
    });
    expect((await down.mine("DELETE", path)).status).toBe(503);
  });
});

describe("the callback's work slot", () => {
  test("a session read that fails at a link's callback holds no slot", async () => {
    const providerWork = new WorkGate(1, 0);
    const h = harness({ providerWork });
    const started = await h.mine("POST", linkStart());
    const { authorization_url } = startProviderLoginResponseSchema.parse(
      await started.json(),
    );
    const back = await idp.authorize(authorization_url, alice);
    h.state.sessionReadFails = true;
    const down = await h.request("POST", "/v1/auth/oidc/callback", {
      body: { provider_id: PROVIDER_ID, ...back },
      cookies: [h.sessionCookie, flowCookieOf(started)],
    });
    expect(down.status).toBe(503);
    expect(providerWork.running).toBe(0);
    h.state.sessionReadFails = false;
    // The one slot there is serves the next person.
    const next = await h.request(
      "POST",
      `/v1/auth/providers/${PROVIDER_ID}/start`,
    );
    const signIn = startProviderLoginResponseSchema.parse(await next.json());
    const answer = await idp.authorize(signIn.authorization_url, alice);
    const signedIn = await h.request("POST", "/v1/auth/oidc/callback", {
      body: { provider_id: PROVIDER_ID, ...answer },
      cookies: [flowCookieOf(next)],
    });
    expect(signedIn.status).toBe(200);
    expect(providerWork.running).toBe(0);
  });
});
