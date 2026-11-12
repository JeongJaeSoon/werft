import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  LOGIN_FLOW_COOKIE_NAME,
  loginMethodsResponseSchema,
  providerLoginCallbackResponseSchema,
  startProviderLoginResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import type {
  ExternalSignInInput,
  ExternalSignInResult,
  IdentityStore,
  LoginProvider,
  LoginProviderAdminStore,
  LoginProviderEntryPreview,
  LoginProviderSecretSlot,
  LoginProviderStore,
  ResolvedWebSession,
} from "@werft-ai/platform";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { createBootstrapGate, WorkGate } from "./auth.ts";
import { createFlowSealer } from "./oidc/flow-cookie.ts";
import { GOOGLE_ISSUER } from "./oidc/index.ts";
import {
  createProviderLogin,
  networkPolicyFor,
  type ProviderLogin,
  ProviderLoginError,
  providerRedirectUri,
} from "./provider-login.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";
import { registerPublicAuthRoutes } from "./routes/auth.ts";

const createApiApp = recordRouteErrors("provider-login.test.ts");

const CLIENT_ID = "client-id.apps.example";
const CLIENT_SECRET = "mock-provider-client-secret";
// On loopback, so the stand-in provider's plain http is allowed.
const CONSOLE_ORIGIN = "http://localhost:5173";
const PROVIDER_ID = "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b";
const OTHER_ID = "0d6a3f1c-2b7e-4c58-9a1d-6e5f4a3b2c1d";
const FLOW_KEY = randomBytes(32);
const TEN_MINUTES = 10 * 60 * 1000;

let idp: MockOidcServer;
beforeAll(async () => {
  idp = await startMockOidcServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
});
afterAll(() => idp.stop());

function providerFor(overrides: Partial<LoginProvider> = {}): LoginProvider {
  return {
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
    ...overrides,
  };
}

/** The store's two reads over rows a test can change between requests. */
function storeOf(rows: LoginProvider[], clientSecret: string | null) {
  const store: LoginProviderStore = {
    listEnabled: async () =>
      rows
        .filter((row) => row.enabled)
        .map(({ id, displayName }) => ({ id, displayName })),
    findForSignIn: async (id) => {
      const provider = rows.find((row) => row.id === id);
      return provider ? { provider: { ...provider }, clientSecret } : null;
    },
  };
  return store;
}

function loginFor(
  overrides: Partial<LoginProvider> = {},
  options: {
    consoleOrigin?: string | null;
    clientSecret?: string | null;
    now?: () => number;
  } = {},
) {
  const rows = [providerFor(overrides)];
  const login = createProviderLogin({
    providers: storeOf(
      rows,
      options.clientSecret === undefined ? CLIENT_SECRET : options.clientSecret,
    ),
    consoleOrigin:
      options.consoleOrigin === undefined
        ? CONSOLE_ORIGIN
        : options.consoleOrigin,
    flowKey: FLOW_KEY,
    ...(options.now ? { now: options.now } : {}),
  });
  return { login, rows, row: rows[0] as LoginProvider };
}

const alice: MockOidcClaims = {
  sub: "1001",
  email: "Alice@Example.com",
  hd: "example.com",
  name: "Alice",
};

async function flow(
  login: ProviderLogin,
  claims: MockOidcClaims,
  providerId = PROVIDER_ID,
) {
  const started = await login.start(providerId);
  const back = await idp.authorize(started.authorizationUrl, claims);
  return {
    cookieValue: started.cookieValue as string | undefined,
    providerId,
    code: back.code,
    state: back.state,
    responseIssuer: undefined as string | undefined,
  };
}

/** The kind and the logged reason a call was refused with. */
async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProviderLoginError) {
      return { kind: error.kind, reason: error.reason };
    }
    throw error;
  }
  return null;
}

describe("provider settings to a connection", () => {
  test("the redirect URI is the console's callback page for that provider", () => {
    expect(
      providerRedirectUri("https://console.example.ts.net/", PROVIDER_ID),
    ).toBe(`https://console.example.ts.net/auth/callback/${PROVIDER_ID}`);
    expect(
      providerRedirectUri("https://console.example.ts.net/some/path?x=1", "p"),
    ).toBe("https://console.example.ts.net/auth/callback/p");
  });

  test("plain http reaches a provider only when the console itself is on loopback", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "https://localhost",
    ]) {
      expect(networkPolicyFor(origin)).toEqual({ plainHttp: "loopback" });
    }
    for (const origin of [
      "https://console.example.ts.net",
      "http://console.internal:3000",
      "http://localhost.example.com",
      "http://10.0.0.5:3000",
    ]) {
      expect(networkPolicyFor(origin)).toEqual({ plainHttp: "refuse" });
    }
  });
});

describe("provider sign-in: start", () => {
  test("asks for a code with PKCE S256, state and nonce, and seals them in the cookie", async () => {
    const { login } = loginFor({ configRevision: 4 });
    const { authorizationUrl, cookieValue } = await login.start(PROVIDER_ID);
    const url = new URL(authorizationUrl);
    const query = url.searchParams;
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/authorize`);
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(CLIENT_ID);
    expect(query.get("redirect_uri")).toBe(
      `${CONSOLE_ORIGIN}/auth/callback/${PROVIDER_ID}`,
    );
    expect(query.get("scope")).toBe("openid email profile");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("hd")).toBeNull();

    const sealed = createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME).open(
      cookieValue,
    );
    expect(sealed).toMatchObject({
      purpose: "login",
      providerId: PROVIDER_ID,
      configRevision: 4,
      state: query.get("state"),
      nonce: query.get("nonce"),
    });
    expect(query.get("code_challenge")).not.toBe(sealed?.verifier);
    for (const secret of [sealed?.state, sealed?.nonce, sealed?.verifier]) {
      expect(cookieValue).not.toContain(secret as string);
    }
  });

  test("Google with one allowed domain is asked for that domain's accounts", async () => {
    const { login } = loginFor({
      issuer: GOOGLE_ISSUER,
      allowedDomains: ["example.com"],
    });
    const { authorizationUrl } = await login.start(PROVIDER_ID);
    expect(new URL(authorizationUrl).searchParams.get("hd")).toBe(
      "example.com",
    );
  });

  test("a provider that is unknown or turned off is not found", async () => {
    const { login } = loginFor({ enabled: false });
    expect(await refusal(login.start(PROVIDER_ID))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
    expect(await refusal(login.start(OTHER_ID))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
  });

  test("without a console origin, a client ID or a client secret there is no sign-in", async () => {
    expect(
      await refusal(
        loginFor({}, { consoleOrigin: null }).login.start(PROVIDER_ID),
      ),
    ).toEqual({ kind: "unavailable", reason: "console_origin_unset" });
    expect(
      await refusal(
        loginFor({}, { clientSecret: null }).login.start(PROVIDER_ID),
      ),
    ).toEqual({ kind: "unavailable", reason: "client_not_configured" });
    expect(
      await refusal(loginFor({ clientId: null }).login.start(PROVIDER_ID)),
    ).toEqual({ kind: "unavailable", reason: "client_not_configured" });
  });

  test("the browser is not sent to a plain http page unless the console is on loopback", async () => {
    const { login } = loginFor(
      {},
      { consoleOrigin: "https://console.example.ts.net" },
    );
    expect(await refusal(login.start(PROVIDER_ID))).toEqual({
      kind: "unavailable",
      reason: "authorization_endpoint_not_allowed",
    });
  });
});

describe("provider sign-in: finish", () => {
  test("returns the provider, the verified identity and how it may come in", async () => {
    const { login } = loginFor();
    const finished = await login.finish(await flow(login, alice));
    expect(finished.provider).toMatchObject({
      id: PROVIDER_ID,
      configRevision: 1,
    });
    expect(finished.identity).toMatchObject({
      issuer: idp.issuer,
      subject: "1001",
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice",
    });
    expect(finished.admission).toEqual({ ownsEmail: true, jitRole: null });
  });

  const refusals: Array<[string, MockOidcClaims]> = [
    ["an unverified email", { ...alice, email_verified: false }],
    ["another audience", { ...alice, aud: "someone-else" }],
    ["another issuer", { ...alice, iss: "https://evil.example" }],
    ["an expired token", { ...alice, exp: Math.floor(Date.now() / 1000) - 5 }],
    ["no exp at all", { ...alice, exp: null }],
    ["another nonce", { ...alice, nonce: "replayed" }],
    ["another authorized party", { ...alice, azp: "someone-else" }],
    ["no subject", { ...alice, sub: "" }],
  ];
  for (const [what, claims] of refusals) {
    test(`refuses ${what}`, async () => {
      const { login } = loginFor();
      expect(
        (await refusal(login.finish(await flow(login, claims))))?.kind,
      ).toBe("rejected");
    });
  }

  test("a provider that says nothing about verification signs in where that is not required, without owning the address", async () => {
    const silent = { ...alice, email_verified: null };
    const { login } = loginFor({
      requireVerifiedEmail: false,
      jitRole: "member",
    });
    const finished = await login.finish(await flow(login, silent));
    expect(finished.identity).toMatchObject({
      subject: "1001",
      email: "alice@example.com",
      emailVerified: null,
    });
    expect(finished.admission).toEqual({ ownsEmail: false, jitRole: null });

    const strict = loginFor().login;
    expect(
      (await refusal(strict.finish(await flow(strict, silent))))?.kind,
    ).toBe("rejected");
    // "Not verified" is believed whatever the setting.
    expect(
      (
        await refusal(
          login.finish(await flow(login, { ...alice, email_verified: false })),
        )
      )?.kind,
    ).toBe("rejected");
  });

  test("refuses no cookie, a cookie that does not open and one sealed with another key", async () => {
    const { login } = loginFor();
    const started = await flow(login, alice);
    const elsewhere = createFlowSealer(
      randomBytes(32),
      LOGIN_FLOW_COOKIE_NAME,
    ).seal({
      purpose: "login",
      providerId: PROVIDER_ID,
      configRevision: 1,
      state: started.state,
      nonce: "n",
      verifier: "v",
      startedAt: Date.now(),
    });
    for (const cookieValue of [
      undefined,
      "",
      "not-a-cookie",
      `${started.state}.n.v.${Date.now()}`,
      elsewhere,
    ]) {
      expect(await refusal(login.finish({ ...started, cookieValue }))).toEqual({
        kind: "rejected",
        reason: "flow_missing",
      });
    }
  });

  test("refuses a state that is not this browser's and a code that was spent", async () => {
    const { login } = loginFor();
    const first = await flow(login, alice);
    const other = await flow(login, alice);
    expect(
      await refusal(login.finish({ ...first, cookieValue: other.cookieValue })),
    ).toEqual({ kind: "rejected", reason: "state_mismatch" });

    const once = await flow(login, alice);
    await login.finish(once);
    expect((await refusal(login.finish(once)))?.kind).toBe("rejected");
  });

  test("refuses a flow older than ten minutes or started in the future", async () => {
    // The callback's clock stays on the real time, which the provider's
    // token is dated by; only the start is moved.
    const callbackAt = Date.now();
    let clock = callbackAt;
    const { login } = loginFor({}, { now: () => clock });
    const startedAt = async (at: number) => {
      clock = at;
      const started = await flow(login, alice);
      clock = callbackAt;
      return started;
    };

    const kept = await startedAt(callbackAt - TEN_MINUTES);
    expect((await login.finish(kept)).identity.subject).toBe("1001");
    const stale = await startedAt(callbackAt - TEN_MINUTES - 1);
    expect(await refusal(login.finish(stale))).toEqual({
      kind: "rejected",
      reason: "flow_expired",
    });

    // A replica whose clock runs a minute ahead sealed the cookie.
    const skewed = await startedAt(callbackAt + 60 * 1000);
    expect((await login.finish(skewed)).identity.subject).toBe("1001");
    const ahead = await startedAt(callbackAt + 60 * 1000 + 1);
    expect(await refusal(login.finish(ahead))).toEqual({
      kind: "rejected",
      reason: "flow_expired",
    });
  });

  test("refuses a flow brought back to another provider's callback", async () => {
    const rows = [providerFor(), providerFor({ id: OTHER_ID })];
    const login = createProviderLogin({
      providers: storeOf(rows, CLIENT_SECRET),
      consoleOrigin: CONSOLE_ORIGIN,
      flowKey: FLOW_KEY,
    });
    const started = await flow(login, alice);
    expect(
      await refusal(login.finish({ ...started, providerId: OTHER_ID })),
    ).toEqual({ kind: "rejected", reason: "provider_mismatch" });
  });

  test("refuses a cookie whose purpose is not a login", async () => {
    const { login } = loginFor();
    const sealer = createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME);
    for (const purpose of ["invite", "link", "test"] as const) {
      const started = await flow(login, alice);
      const opened = sealer.open(started.cookieValue);
      if (!opened) throw new Error("the started flow did not open");
      expect(
        await refusal(
          login.finish({
            ...started,
            cookieValue: sealer.seal({
              ...opened,
              purpose,
              // A test flow opens only with who runs it.
              ...(purpose === "test"
                ? {
                    test: {
                      userId: OWNER.userId,
                      sessionId: OWNER.sessionId,
                      secretSlot: "current" as const,
                      secretVersion: 1,
                    },
                  }
                : {}),
            }),
          }),
        ),
      ).toEqual({ kind: "rejected", reason: "flow_purpose" });
    }
  });

  test("refuses a flow whose provider's settings changed after it started", async () => {
    const { login, row } = loginFor();
    const started = await flow(login, alice);
    row.configRevision += 1;
    expect(await refusal(login.finish(started))).toEqual({
      kind: "rejected",
      reason: "config_changed",
    });
  });

  test("a provider turned off or removed after the start is not found", async () => {
    const off = loginFor();
    const started = await flow(off.login, alice);
    off.row.enabled = false;
    expect(await refusal(off.login.finish(started))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });

    const gone = loginFor();
    const orphan = await flow(gone.login, alice);
    gone.rows.length = 0;
    expect(await refusal(gone.login.finish(orphan))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
  });

  test("an address outside the allowed domains is forbidden, after the token is verified", async () => {
    const { login } = loginFor({ allowedDomains: ["example.com"] });
    expect(
      await refusal(
        login.finish(
          await flow(login, { ...alice, email: "alice@other.example" }),
        ),
      ),
    ).toEqual({ kind: "forbidden", reason: "domain_not_allowed" });
    expect(
      (
        await refusal(
          login.finish(
            await flow(login, {
              ...alice,
              email: "alice@other.example",
              aud: "someone-else",
            }),
          ),
        )
      )?.kind,
    ).toBe("rejected");
  });

  test("a provider that cannot be reached is unavailable, and the next request tries again", async () => {
    const { login, row } = loginFor();
    const started = await flow(login, alice);
    const tokenEndpoint = row.tokenEndpoint;
    row.tokenEndpoint = "http://127.0.0.1:9/token";
    expect((await refusal(login.finish(started)))?.kind).toBe("unavailable");
    row.tokenEndpoint = tokenEndpoint;
    expect((await login.finish(started)).identity.subject).toBe("1001");
  });
});

const OWNER = {
  userId: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
  sessionId: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";

type RecordedTest = Parameters<LoginProviderAdminStore["recordTest"]>[0];

/**
 * The owner's side over one row and one stored secret, both of which a
 * test can change between the start and the callback.
 */
function adminOf(overrides: Partial<LoginProvider> = {}) {
  const stored = {
    row: providerFor({ enabled: false, ...overrides }),
    slot: "current" as LoginProviderSecretSlot,
    clientSecret: CLIENT_SECRET as string | null,
    secretVersion: 1 as number | null,
    known: "none" as LoginProviderEntryPreview,
    outcome: "recorded" as "recorded" | "stale" | "not_found",
  };
  const recorded: RecordedTest[] = [];
  const admin: Pick<
    LoginProviderAdminStore,
    "findForTest" | "recordTest" | "previewEntry"
  > = {
    findForTest: async (id) =>
      id === stored.row.id
        ? {
            provider: { ...stored.row },
            slot: stored.slot,
            clientSecret: stored.clientSecret,
            secretVersion: stored.secretVersion,
          }
        : null,
    recordTest: async (input) => {
      recorded.push(input);
      return { outcome: stored.outcome };
    },
    previewEntry: async () => stored.known,
  };
  return { admin, stored, recorded };
}

describe("provider test sign-in", () => {
  function testFor(overrides: Partial<LoginProvider> = {}) {
    const { admin, stored, recorded } = adminOf(overrides);
    const login = createProviderLogin({
      providers: storeOf([stored.row], CLIENT_SECRET),
      admin,
      consoleOrigin: CONSOLE_ORIGIN,
      flowKey: FLOW_KEY,
    });
    const start = () =>
      login.startTest({
        providerId: PROVIDER_ID,
        userId: OWNER.userId,
        sessionId: OWNER.sessionId,
      });
    /** A whole test; `between` runs after the provider answered. */
    const run = async (
      claims: MockOidcClaims,
      between: () => void = () => {},
      owner: typeof OWNER | null = OWNER,
    ) => {
      const started = await start();
      const back = await idp.authorize(started.authorizationUrl, claims);
      between();
      return login.finishTest({
        cookieValue: started.cookieValue,
        providerId: PROVIDER_ID,
        code: back.code,
        state: back.state,
        responseIssuer: undefined,
        owner,
        receiptId: RECEIPT_ID,
      });
    };
    return { login, stored, recorded, start, run };
  }

  test("runs on a provider that is off, where a sign-in does not start", async () => {
    const { login, start } = testFor();
    expect(await refusal(login.start(PROVIDER_ID))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
    const { authorizationUrl } = await start();
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      `${CONSOLE_ORIGIN}/auth/callback/${PROVIDER_ID}`,
    );
  });

  test("the flow cookie names the owner, their session and the secret the test tries", async () => {
    const { stored, start } = testFor({ configRevision: 7 });
    stored.slot = "next";
    stored.secretVersion = 3;
    const { cookieValue } = await start();
    expect(
      createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME).open(cookieValue),
    ).toMatchObject({
      purpose: "test",
      providerId: PROVIDER_ID,
      configRevision: 7,
      test: {
        userId: OWNER.userId,
        sessionId: OWNER.sessionId,
        secretSlot: "next",
        secretVersion: 3,
      },
    });
  });

  test("a pass says who the provider vouched for and is written down for the owner, with the secret it ran with", async () => {
    const { recorded, run } = testFor({ configRevision: 4 });
    expect(await run(alice)).toEqual({
      providerId: PROVIDER_ID,
      test: {
        passed: true,
        recorded: true,
        subject: "1001",
        email: "alice@example.com",
        email_verified: true,
        address_owned: true,
        entry: "invite_only",
      },
    });
    expect(recorded).toEqual([
      {
        id: PROVIDER_ID,
        configRevision: 4,
        slot: "current",
        clientSecret: CLIENT_SECRET,
        audit: {
          userId: OWNER.userId,
          workspaceId: OWNER.workspaceId,
          receiptId: RECEIPT_ID,
        },
      },
    ]);
  });

  test("does not start for a provider that is not there, one with no client secret, or with no owner's side wired", async () => {
    const { login, stored } = testFor();
    expect(
      await refusal(login.startTest({ ...OWNER, providerId: OTHER_ID })),
    ).toEqual({ kind: "not_found", reason: "provider_missing" });
    stored.clientSecret = null;
    stored.secretVersion = null;
    expect(
      await refusal(login.startTest({ ...OWNER, providerId: PROVIDER_ID })),
    ).toEqual({ kind: "unavailable", reason: "client_not_configured" });

    const { login: unwired } = loginFor({ enabled: false });
    expect(
      await refusal(unwired.startTest({ ...OWNER, providerId: PROVIDER_ID })),
    ).toEqual({ kind: "not_found", reason: "provider_missing" });
  });

  const strangers: Array<[string, typeof OWNER | null]> = [
    ["nobody signed in, or someone who is not an owner", null],
    ["another owner", { ...OWNER, userId: OTHER_ID }],
    ["the same owner in another session", { ...OWNER, sessionId: OTHER_ID }],
  ];
  for (const [who, owner] of strangers) {
    test(`a test brought back by ${who} is refused and nothing is written down`, async () => {
      const { recorded, run } = testFor();
      expect(await refusal(run(alice, undefined, owner))).toEqual({
        kind: "rejected",
        reason: "test_session",
      });
      expect(recorded).toEqual([]);
    });
  }

  test("a sign-in's cookie does not finish as a test, nor a test's as a sign-in", async () => {
    const { admin, stored } = adminOf({ enabled: true });
    const login = createProviderLogin({
      providers: storeOf([stored.row], CLIENT_SECRET),
      admin,
      consoleOrigin: CONSOLE_ORIGIN,
      flowKey: FLOW_KEY,
    });
    const signIn = await flow(login, alice);
    expect(
      await refusal(
        login.finishTest({ ...signIn, owner: OWNER, receiptId: RECEIPT_ID }),
      ),
    ).toEqual({ kind: "rejected", reason: "flow_purpose" });

    const started = await login.startTest({
      ...OWNER,
      providerId: PROVIDER_ID,
    });
    const back = await idp.authorize(started.authorizationUrl, alice);
    expect(
      await refusal(
        login.finish({
          cookieValue: started.cookieValue,
          providerId: PROVIDER_ID,
          code: back.code,
          state: back.state,
          responseIssuer: undefined,
        }),
      ),
    ).toEqual({ kind: "rejected", reason: "flow_purpose" });
  });

  const answers: Array<[string, MockOidcClaims, string]> = [
    [
      "another audience",
      { ...alice, aud: "someone-else" },
      "audience_mismatch",
    ],
    [
      "another issuer",
      { ...alice, iss: "https://evil.example" },
      "issuer_mismatch",
    ],
    ["another nonce", { ...alice, nonce: "replayed" }, "nonce_mismatch"],
    [
      "an unverified email",
      { ...alice, email_verified: false },
      "email_unverified",
    ],
  ];
  for (const [what, claims, reason] of answers) {
    test(`an answer with ${what} fails the test with its reason and is not written down`, async () => {
      const { recorded, run } = testFor();
      expect(await run(claims)).toEqual({
        providerId: PROVIDER_ID,
        test: { passed: false, reason },
      });
      expect(recorded).toEqual([]);
    });
  }

  test("a client secret the provider does not take fails the test and is not written down", async () => {
    const { stored, recorded, run } = testFor();
    stored.clientSecret = "not-the-provider's-secret";
    expect(await run(alice)).toEqual({
      providerId: PROVIDER_ID,
      test: { passed: false, reason: "code_refused" },
    });
    expect(recorded).toEqual([]);
  });

  const changes: Array<
    [string, (stored: ReturnType<typeof adminOf>["stored"]) => void]
  > = [
    [
      "the settings",
      (stored) => {
        stored.row.configRevision += 1;
      },
    ],
    [
      "the secret",
      (stored) => {
        stored.secretVersion = 2;
      },
    ],
    [
      "which secret is tried",
      (stored) => {
        stored.slot = "next";
      },
    ],
    [
      "the secret to none",
      (stored) => {
        stored.clientSecret = null;
        stored.secretVersion = null;
      },
    ],
  ];
  for (const [what, change] of changes) {
    test(`a test that comes back after someone changed ${what} is not a pass and is not written down`, async () => {
      const { stored, recorded, run } = testFor();
      expect(await run(alice, () => change(stored))).toEqual({
        providerId: PROVIDER_ID,
        test: { passed: false, reason: "config_changed" },
      });
      expect(recorded).toEqual([]);
    });
  }

  test("a pass the store finds stale is told as passed and not recorded", async () => {
    const { stored, run } = testFor();
    stored.outcome = "stale";
    expect((await run(alice)).test).toMatchObject({
      passed: true,
      recorded: false,
    });
  });

  test("a provider that is gone when the test comes back is not found", async () => {
    const { stored, run } = testFor();
    expect(
      await refusal(
        run(alice, () => {
          stored.row = providerFor({ id: OTHER_ID });
        }),
      ),
    ).toEqual({ kind: "not_found", reason: "provider_missing" });
  });

  test("says what a sign-in by the tested account would meet, without making anything", async () => {
    const silent = { ...alice, email_verified: null };
    const cases: Array<{
      provider?: Partial<LoginProvider>;
      known: LoginProviderEntryPreview;
      claims: MockOidcClaims;
      entry: string;
    }> = [
      { known: "linked", claims: alice, entry: "signs_in" },
      // A user or an account that is turned off, or in no workspace.
      { known: "refused", claims: alice, entry: "refused" },
      {
        // The domain rule is asked first, as at a sign-in.
        provider: { allowedDomains: ["elsewhere.example"] },
        known: "refused",
        claims: alice,
        entry: "domain_not_allowed",
      },
      { known: "account_exists", claims: alice, entry: "link_required" },
      {
        provider: { requireVerifiedEmail: false },
        known: "account_exists",
        claims: silent,
        entry: "refused",
      },
      {
        provider: { jitRole: "member" },
        known: "none",
        claims: alice,
        entry: "joins",
      },
      { known: "none", claims: alice, entry: "invite_only" },
      {
        // Joining by itself takes an address the provider vouches for.
        provider: { requireVerifiedEmail: false, jitRole: "member" },
        known: "none",
        claims: silent,
        entry: "invite_only",
      },
      {
        provider: { allowedDomains: ["elsewhere.example"], jitRole: "member" },
        known: "none",
        claims: alice,
        entry: "domain_not_allowed",
      },
    ];
    for (const { provider, known, claims, entry } of cases) {
      const { stored, recorded, run } = testFor(provider);
      stored.known = known;
      const { test: result } = await run(claims);
      expect(result, entry).toMatchObject({ passed: true, entry });
      // The connection passed whoever the account is.
      expect(recorded, entry).toHaveLength(1);
    }
  });
});

describe("provider sign-in routes", () => {
  const signedIn: ExternalSignInResult = {
    outcome: "signed_in",
    via: "jit",
    userId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    role: "member",
    expiresAt: new Date(Date.now() + 60_000),
  };

  function harness(
    options: {
      provider?: Partial<LoginProvider>;
      rows?: LoginProvider[];
      providers?: ProviderLogin | null;
      store?: LoginProviderStore;
      result?: ExternalSignInResult;
      providerWork?: WorkGate;
      /** Whom the console session cookie of a request resolves to. */
      session?: ResolvedWebSession | null;
    } = {},
  ) {
    const calls: ExternalSignInInput[] = [];
    const identity = {
      async signInWithExternalIdentity(input: ExternalSignInInput) {
        calls.push(input);
        return options.result ?? signedIn;
      },
      resolveWebSession: async () => options.session ?? null,
    } as unknown as IdentityStore;
    const rows = options.rows ?? [providerFor(options.provider)];
    const providers =
      options.providers === undefined
        ? createProviderLogin({
            providers: options.store ?? storeOf(rows, CLIENT_SECRET),
            consoleOrigin: CONSOLE_ORIGIN,
            flowKey: FLOW_KEY,
          })
        : options.providers;
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const app = createApiApp({
      authMode: "api-key",
      logger,
      identity,
      keyStore: { find: async () => null },
      registerPublicRoutes: (router) =>
        registerPublicAuthRoutes(router, {
          identity,
          logger,
          bootstrap: createBootstrapGate("x".repeat(32)),
          ...(providers ? { providers } : {}),
          ...(options.providerWork
            ? { providerWork: options.providerWork }
            : {}),
        }),
    });
    const post = (
      path: string,
      init: { body?: unknown; cookie?: string } = {},
    ) =>
      app.request(path, {
        method: "POST",
        headers: {
          [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
          "Content-Type": "application/json",
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    const startPath = (id = PROVIDER_ID) => `/v1/auth/providers/${id}/start`;
    /** The start request and the provider's answer, not yet brought back. */
    const begin = async (claims: MockOidcClaims, id = PROVIDER_ID) => {
      const started = await post(startPath(id));
      expect(started.status).toBe(200);
      const flowCookie =
        (started.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
      const { authorization_url } = startProviderLoginResponseSchema.parse(
        await started.json(),
      );
      const back = await idp.authorize(authorization_url, claims);
      return { flowCookie, body: { provider_id: id, ...back } };
    };
    const signIn = async (claims: MockOidcClaims) => {
      const { flowCookie, body } = await begin(claims);
      return post("/v1/auth/oidc/callback", { body, cookie: flowCookie });
    };
    return { app, post, begin, signIn, calls, rows, sink, startPath };
  }

  const errorOf = async (response: Response) => {
    const { error } = await response.json();
    return { ...error, request_id: undefined };
  };
  const clearsFlowCookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .some((cookie) => cookie.startsWith(`${LOGIN_FLOW_COOKIE_NAME}=;`));

  test("the login page is offered the providers that are on, by id and label", async () => {
    const { app } = harness({
      rows: [
        providerFor({ displayName: "Google" }),
        providerFor({ id: OTHER_ID, displayName: "Okta", enabled: false }),
      ],
    });
    const response = await app.request("/v1/auth/login-methods");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(loginMethodsResponseSchema.parse(body)).toEqual({
      password: "on",
      providers: [{ id: PROVIDER_ID, display_name: "Google" }],
    });
    expect(JSON.stringify(body)).not.toContain(CLIENT_ID);
  });

  test("with no provider the login page is offered the password alone", async () => {
    for (const h of [harness({ providers: null }), harness({ rows: [] })]) {
      expect(
        await (await h.app.request("/v1/auth/login-methods")).json(),
      ).toEqual({ password: "on", providers: [] });
    }
  });

  test("a storage outage answers 503 on every route", async () => {
    const down = async () => {
      throw Object.assign(new Error("too many connections"), {
        code: "53300",
      });
    };
    const { app, post, startPath } = harness({
      store: { listEnabled: down, findForSignIn: down },
    });
    expect((await app.request("/v1/auth/login-methods")).status).toBe(503);
    expect((await post(startPath())).status).toBe(503);
  });

  test("start sets a flow cookie scoped like the session cookie", async () => {
    const { post, startPath } = harness();
    const response = await post(startPath());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toStartWith("__Host-werft_login_flow=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).not.toContain("Domain=");
  });

  test("a sign-in sets the session cookie, clears the flow cookie and answers the login body", async () => {
    const { signIn, calls } = harness();
    const response = await signIn(alice);
    expect(response.status).toBe(200);
    const body = providerLoginCallbackResponseSchema.parse(
      await response.json(),
    );
    expect(body.outcome).toBe("signed_in");
    if (body.outcome !== "signed_in") throw new Error("not a sign-in");
    expect(body.role).toBe("member");
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)),
    ).toBe(true);
    expect(clearsFlowCookie(response)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "oidc",
      provider: { id: PROVIDER_ID, configRevision: 1 },
      issuer: idp.issuer,
      subject: "1001",
      email: "alice@example.com",
      displayName: "Alice",
      jitRole: null,
      ownsEmail: true,
    });
  });

  test("JIT passes the member role down; a nameless account is named by its address", async () => {
    const { signIn, calls } = harness({
      provider: { allowedDomains: ["example.com"], jitRole: "member" },
    });
    expect(
      (await signIn({ sub: "1001", email: "Alice@Example.com" })).status,
    ).toBe(200);
    expect(calls[0]).toMatchObject({ jitRole: "member", displayName: "alice" });
  });

  test("an address that has an account answers 409 LOGIN_LINK_REQUIRED", async () => {
    const { signIn } = harness({ result: { outcome: "link_required" } });
    const response = await signIn(alice);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("LOGIN_LINK_REQUIRED");
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)),
    ).toBe(false);
  });

  test("every refusal reads the same and says nothing of why; the log does", async () => {
    const byRules = harness({ result: { outcome: "rejected" } });
    const responses: Response[] = [await byRules.signIn(alice)];

    const h = harness();
    responses.push(await h.signIn({ ...alice, email_verified: false }));
    const noCookie = await h.begin(alice);
    responses.push(
      await h.post("/v1/auth/oidc/callback", { body: noCookie.body }),
    );
    const forged = await h.begin(alice);
    responses.push(
      await h.post("/v1/auth/oidc/callback", {
        body: forged.body,
        cookie: `${LOGIN_FLOW_COOKIE_NAME}=not-a-cookie`,
      }),
    );
    const otherState = await h.begin(alice);
    responses.push(
      await h.post("/v1/auth/oidc/callback", {
        body: { ...otherState.body, state: "another-state" },
        cookie: otherState.flowCookie,
      }),
    );
    const changed = await h.begin(alice);
    (h.rows[0] as LoginProvider).configRevision += 1;
    responses.push(
      await h.post("/v1/auth/oidc/callback", {
        body: changed.body,
        cookie: changed.flowCookie,
      }),
    );

    const errors = [];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(clearsFlowCookie(response)).toBe(true);
      expect(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)),
      ).toBe(false);
      errors.push(await errorOf(response));
    }
    expect(errors[0]).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Sign-in was not accepted",
    });
    for (const error of errors) expect(error).toEqual(errors[0]);

    const reasons = [...byRules.sink.records, ...h.sink.records]
      .map((record) => JSON.stringify(record))
      .filter((line) => line.includes("Provider sign-in refused"));
    for (const reason of [
      "no_rule_admits",
      "flow_missing",
      "state_mismatch",
      "config_changed",
    ]) {
      expect(reasons.some((line) => line.includes(reason))).toBe(true);
    }
    // Only the rules were asked about the one the provider vouched for.
    expect(byRules.calls).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });

  test("a flow started for one provider is refused at another provider's callback", async () => {
    const h = harness({
      rows: [providerFor(), providerFor({ id: OTHER_ID })],
    });
    const { flowCookie, body } = await h.begin(alice);
    const response = await h.post("/v1/auth/oidc/callback", {
      body: { ...body, provider_id: OTHER_ID },
      cookie: flowCookie,
    });
    expect(response.status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  test("a domain outside the list answers 403 before any rule runs", async () => {
    const { signIn, calls } = harness({
      provider: { allowedDomains: ["example.com"] },
    });
    const response = await signIn({ ...alice, email: "alice@other.example" });
    expect(response.status).toBe(403);
    expect(clearsFlowCookie(response)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a provider that is off answers 404 at the start and at the callback", async () => {
    const h = harness();
    const { flowCookie, body } = await h.begin(alice);
    (h.rows[0] as LoginProvider).enabled = false;
    expect((await h.post(h.startPath())).status).toBe(404);
    const callback = await h.post("/v1/auth/oidc/callback", {
      body,
      cookie: flowCookie,
    });
    expect(callback.status).toBe(404);
    expect(clearsFlowCookie(callback)).toBe(true);
    expect(h.calls).toHaveLength(0);
    expect((await h.post(h.startPath(OTHER_ID))).status).toBe(404);
  });

  test("a provider turned off between the callback's checks and the session answers 404 with no session", async () => {
    const { signIn, calls } = harness({ result: { outcome: "provider_off" } });
    const response = await signIn(alice);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`)),
    ).toBe(false);
  });

  test("both routes answer 404 on an installation with no provider sign-in", async () => {
    const { post, startPath } = harness({ providers: null });
    expect((await post(startPath())).status).toBe(404);
    expect(
      (
        await post("/v1/auth/oidc/callback", {
          body: { provider_id: PROVIDER_ID, code: "c", state: "s" },
        })
      ).status,
    ).toBe(404);
  });

  test("both routes refuse a request without the CSRF header", async () => {
    const { app, startPath } = harness();
    for (const path of [startPath(), "/v1/auth/oidc/callback"]) {
      const response = await app.request(path, { method: "POST" });
      expect(response.status).toBe(403);
    }
  });

  test("a callback refused before the flow is opened clears the flow cookie all the same", async () => {
    const { app, post, begin } = harness();
    const { flowCookie, body } = await begin({
      sub: "s-1",
      email: "ada@example.com",
    });
    const { state: _state, ...stateless } = body;
    const malformed = await post("/v1/auth/oidc/callback", {
      body: stateless,
      cookie: flowCookie,
    });
    expect(malformed.status).toBe(400);
    expect(clearsFlowCookie(malformed)).toBe(true);

    const oversized = await post("/v1/auth/oidc/callback", {
      body: { ...body, code: "x".repeat(65 * 1024) },
      cookie: flowCookie,
    });
    expect(oversized.status).toBe(413);
    expect(clearsFlowCookie(oversized)).toBe(true);

    const forged = await app.request("/v1/auth/oidc/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: flowCookie },
      body: JSON.stringify(body),
    });
    expect(forged.status).toBe(403);
    expect(clearsFlowCookie(forged)).toBe(true);
  });

  test("a provider id that is not a UUID is not found, without a read", async () => {
    let reads = 0;
    const { post, startPath } = harness({
      store: {
        listEnabled: async () => [],
        findForSignIn: async () => {
          reads += 1;
          return null;
        },
      },
    });
    expect((await post(startPath("google"))).status).toBe(404);
    expect(reads).toBe(0);
  });

  test("a malformed callback is 400 and an oversized one 413", async () => {
    const { post } = harness();
    for (const body of [
      { code: 1 },
      { code: "c", state: "s" },
      { provider_id: "google", code: "c", state: "s" },
      { provider_id: PROVIDER_ID, code: "c", state: "s", extra: true },
    ]) {
      expect((await post("/v1/auth/oidc/callback", { body })).status).toBe(400);
    }
    const oversized = await post("/v1/auth/oidc/callback", {
      body: {
        provider_id: PROVIDER_ID,
        code: "x".repeat(65 * 1024),
        state: "s",
      },
    });
    expect(oversized.status).toBe(413);
  });

  test("a callback beyond the provider work in progress answers 429 without calling the provider", async () => {
    const providerWork = new WorkGate(1, 0);
    const h = harness({ providerWork });
    const { flowCookie, body } = await h.begin(alice);
    const release = await (providerWork.tryAcquire() as Promise<() => void>);
    const busy = await h.post("/v1/auth/oidc/callback", {
      body,
      cookie: flowCookie,
    });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect(h.calls).toHaveLength(0);
    release();
    // The slot is given back whatever the callback ends in.
    expect((await h.signIn({ ...alice, aud: "someone-else" })).status).toBe(
      401,
    );
    expect((await h.signIn(alice)).status).toBe(200);
    expect(providerWork.running).toBe(0);
  });

  test("an unreachable provider answers 503 and is retried by the next request", async () => {
    const h = harness();
    const { flowCookie, body } = await h.begin(alice);
    const row = h.rows[0] as LoginProvider;
    const tokenEndpoint = row.tokenEndpoint;
    row.tokenEndpoint = "http://127.0.0.1:9/token";
    const callback = await h.post("/v1/auth/oidc/callback", {
      body,
      cookie: flowCookie,
    });
    expect(callback.status).toBe(503);
    expect((await callback.json()).error.retryable).toBe(true);
    row.tokenEndpoint = tokenEndpoint;
    expect((await h.signIn(alice)).status).toBe(200);
  });

  test("a provider with no client secret answers 503 at the start", async () => {
    const { post, startPath } = harness({
      store: storeOf([providerFor()], null),
    });
    const started = await post(startPath());
    expect(started.status).toBe(503);
    expect((await started.json()).error.retryable).toBe(true);
  });

  describe("the callback of an owner's test", () => {
    const ownerSession: ResolvedWebSession = {
      sessionId: OWNER.sessionId,
      userId: OWNER.userId,
      email: "owner@example.com",
      displayName: "Owner",
      locale: null,
      workspaceId: OWNER.workspaceId,
      role: "owner",
      expiresAt: new Date(Date.now() + 60_000),
    };

    function testHarness(session: ResolvedWebSession | null) {
      const { admin, stored, recorded } = adminOf();
      const login = createProviderLogin({
        providers: storeOf([stored.row], CLIENT_SECRET),
        admin,
        consoleOrigin: CONSOLE_ORIGIN,
        flowKey: FLOW_KEY,
      });
      const h = harness({ providers: login, session });
      /** A test started by OWNER, brought back with this request's cookies. */
      const bring = async (claims: MockOidcClaims) => {
        const started = await login.startTest({
          ...OWNER,
          providerId: PROVIDER_ID,
        });
        const back = await idp.authorize(started.authorizationUrl, claims);
        return h.post("/v1/auth/oidc/callback", {
          body: { provider_id: PROVIDER_ID, ...back },
          cookie: `${LOGIN_FLOW_COOKIE_NAME}=${started.cookieValue}; ${WEB_SESSION_COOKIE_NAME}=console-session`,
        });
      };
      return { ...h, bring, stored, recorded };
    }

    const setsSession = (response: Response) =>
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${WEB_SESSION_COOKIE_NAME}=`));

    test("answers what the provider said, records the pass, and makes no account and no session", async () => {
      const h = testHarness(ownerSession);
      const response = await h.bring(alice);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(clearsFlowCookie(response)).toBe(true);
      expect(setsSession(response)).toBe(false);
      expect(
        providerLoginCallbackResponseSchema.parse(await response.json()),
      ).toEqual({
        outcome: "tested",
        provider_id: PROVIDER_ID,
        test: {
          passed: true,
          recorded: true,
          subject: "1001",
          email: "alice@example.com",
          email_verified: true,
          address_owned: true,
          entry: "invite_only",
        },
      });
      // The sign-in that makes users and sessions was never asked.
      expect(h.calls).toEqual([]);
      expect(h.recorded).toHaveLength(1);
      expect(h.recorded[0]?.audit).toMatchObject({
        userId: OWNER.userId,
        workspaceId: OWNER.workspaceId,
      });
      expect(h.recorded[0]?.audit.receiptId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const logged = h.sink.records.filter(
        (record) => record.message === "Provider test sign-in",
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]?.fields).toMatchObject({
        provider_id: PROVIDER_ID,
        passed: true,
        recorded: true,
      });
      // Who the owner tested with is theirs to see, not the log's.
      expect(JSON.stringify(h.sink.records)).not.toContain("alice@example.com");
    });

    test("a failed test answers 200 with the reason, and records nothing", async () => {
      const h = testHarness(ownerSession);
      const response = await h.bring({ ...alice, aud: "someone-else" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        outcome: "tested",
        provider_id: PROVIDER_ID,
        test: { passed: false, reason: "audience_mismatch" },
      });
      expect(h.recorded).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(setsSession(response)).toBe(false);
    });

    const others: Array<[string, ResolvedWebSession | null]> = [
      ["no console session", null],
      ["an admin's session", { ...ownerSession, role: "admin" }],
      ["a member's session", { ...ownerSession, role: "member" }],
      ["another owner's session", { ...ownerSession, userId: OTHER_ID }],
      ["the owner's other session", { ...ownerSession, sessionId: OTHER_ID }],
    ];
    for (const [what, session] of others) {
      test(`with ${what} it is 401: nothing recorded, nobody signed in`, async () => {
        const h = testHarness(session);
        const response = await h.bring(alice);
        expect(response.status).toBe(401);
        expect(await errorOf(response)).toMatchObject({
          code: "UNAUTHORIZED",
          message: "Sign-in was not accepted",
        });
        expect(clearsFlowCookie(response)).toBe(true);
        expect(setsSession(response)).toBe(false);
        expect(h.recorded).toEqual([]);
        expect(h.calls).toEqual([]);
      });
    }

    test("a test's cookie never signs anyone in, even where the provider is on", async () => {
      const h = testHarness(null);
      h.stored.row.enabled = true;
      const response = await h.bring(alice);
      expect(response.status).toBe(401);
      expect(setsSession(response)).toBe(false);
      expect(h.calls).toEqual([]);
    });
  });
});
