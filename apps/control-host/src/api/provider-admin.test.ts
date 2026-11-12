import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type LoginProviderAdminStore,
  type LoginProviderRecord,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { createProviderAdmin } from "./provider-admin.ts";
import { type ProviderLogin, ProviderLoginError } from "./provider-login.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;
const ID = "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b";
const SESSION = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
// On loopback, so the stand-in provider's plain http is allowed.
const CONSOLE_ORIGIN = "http://localhost:5173";
const AT = new Date("2026-11-04T03:00:00.000Z");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

let idp: MockOidcServer;
beforeAll(async () => {
  idp = await startMockOidcServer({
    clientId: "werft-console",
    clientSecret: "example-client-secret",
  });
});
afterAll(() => idp.stop());

const SECRET = { last4: "9f3a", secretVersion: 1, updatedAt: AT };

function record(over: Partial<LoginProviderRecord> = {}): LoginProviderRecord {
  return {
    id: ID,
    displayName: "Keycloak",
    issuer: "https://idp.example.com/realms/acme",
    authorizationEndpoint: "https://login.example.com/realms/acme/auth",
    tokenEndpoint: "https://idp.example.com/realms/acme/token",
    jwksUri: "https://keys.example.com/realms/acme/certs",
    userinfoEndpoint: null,
    signingAlgs: ["RS256"],
    issParameterRequired: false,
    clientId: "werft-console",
    tokenAuthMethod: "client_secret_basic",
    allowedDomains: [],
    jitRole: null,
    requireVerifiedEmail: true,
    enabled: false,
    configRevision: 3,
    pkceAdvertised: true,
    discoveryCheckedAt: AT,
    testedConfigRevision: null,
    testedAt: null,
    revision: 5,
    createdAt: AT,
    updatedAt: AT,
    clientSecret: SECRET,
    pendingClientSecret: null,
    ...over,
  };
}

type StoreMethod = keyof LoginProviderAdminStore;

/**
 * The service over a store that answers what a test tells it to and keeps
 * what it was asked.
 */
function service(
  options: {
    rows?: LoginProviderRecord[];
    answers?: Partial<Record<StoreMethod, unknown>>;
    consoleOrigin?: string | null;
    startTest?: ProviderLogin["startTest"];
  } = {},
) {
  const rows = options.rows ?? [record()];
  const asked: Array<{ method: StoreMethod; input: unknown }> = [];
  const answering =
    (method: StoreMethod, fallback: unknown) => async (input: unknown) => {
      asked.push({ method, input });
      return options.answers?.[method] ?? fallback;
    };
  const store = {
    list: async () => rows,
    create: answering("create", { outcome: "created", provider: rows[0] }),
    update: answering("update", { outcome: "updated", provider: rows[0] }),
    refreshDiscovery: answering("refreshDiscovery", {
      outcome: "updated",
      provider: rows[0],
    }),
    setClientSecret: answering("setClientSecret", {
      outcome: "stored",
      provider: rows[0],
    }),
    enable: answering("enable", { outcome: "enabled", provider: rows[0] }),
    disable: answering("disable", {
      outcome: "disabled",
      provider: rows[0],
      sessionsRevoked: 0,
    }),
    delete: answering("delete", { outcome: "deleted" }),
  } as unknown as LoginProviderAdminStore;
  const started: Parameters<ProviderLogin["startTest"]>[0][] = [];
  const admin = createProviderAdmin({
    authorization: createAuthorizationPolicy({
      agents: { agentOf: async () => null, isAdmin: async () => false },
      decisions: { record: async () => {} },
    }),
    store,
    login: {
      startTest:
        options.startTest ??
        (async (input) => {
          started.push(input);
          return {
            authorizationUrl: "https://idp/auth",
            cookieValue: "sealed",
          };
        }),
    },
    consoleOrigin:
      options.consoleOrigin === undefined
        ? CONSOLE_ORIGIN
        : options.consoleOrigin,
  });
  return { admin, asked, started };
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("sign-in provider settings service", () => {
  test("every method is the signed-in owner's: an admin, a member and an owner's API key change and see nothing", async () => {
    const { admin, asked, started } = service();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      const attempts = [
        admin.list(who),
        admin.discover(who, idp.issuer),
        admin.create(who, { display_name: "Mock", issuer: idp.issuer }),
        admin.update(who, ID, "5", { display_name: "Renamed" }),
        admin.refreshDiscovery(who, ID),
        admin.setClientSecret(who, ID, "example-client-secret"),
        admin.startTest(who, ID, SESSION),
        admin.enable(who, ID),
        admin.disable(who, ID),
        admin.remove(who, ID),
      ];
      for (const attempt of attempts) {
        expect((await refusal(attempt)).code).toBe("FORBIDDEN");
      }
    }
    expect(asked).toEqual([]);
    expect(started).toEqual([]);
  });

  test("a provider shows its redirect URI, the hosts the server calls, and never a secret's value", async () => {
    const { admin } = service({
      rows: [
        record({
          userinfoEndpoint: "https://idp.example.com/realms/acme/userinfo",
          allowedDomains: ["example.com"],
          jitRole: "member",
        }),
      ],
    });
    const listed = await admin.list(caller("owner"));
    expect(listed.console_origin_configured).toBe(true);
    expect(listed.providers).toEqual([
      {
        id: ID,
        display_name: "Keycloak",
        issuer: "https://idp.example.com/realms/acme",
        redirect_uri: `${CONSOLE_ORIGIN}/auth/callback/${ID}`,
        authorization_endpoint: "https://login.example.com/realms/acme/auth",
        token_endpoint: "https://idp.example.com/realms/acme/token",
        jwks_uri: "https://keys.example.com/realms/acme/certs",
        userinfo_endpoint: "https://idp.example.com/realms/acme/userinfo",
        // The browser goes to the authorization endpoint; the server does not.
        endpoint_hosts: ["idp.example.com", "keys.example.com"],
        signing_algs: ["RS256"],
        pkce_advertised: true,
        discovery_checked_at: AT.toISOString(),
        client_id: "werft-console",
        token_auth_method: "client_secret_basic",
        client_secret: { last4: "9f3a", updated_at: AT.toISOString() },
        pending_client_secret: null,
        allowed_domains: ["example.com"],
        jit_role: "member",
        require_verified_email: true,
        state: "needs_test",
        tested_at: null,
        revision: 5,
        created_at: AT.toISOString(),
        updated_at: AT.toISOString(),
      },
    ]);
  });

  test("without CONSOLE_ORIGIN the list still answers, with no redirect URI", async () => {
    const { admin } = service({ consoleOrigin: null });
    const listed = await admin.list(caller("owner"));
    expect(listed.console_origin_configured).toBe(false);
    expect(listed.providers[0]?.redirect_uri).toBeNull();
  });

  test("state says where a provider stands", async () => {
    const tested = { testedConfigRevision: 3, testedAt: AT };
    const cases: Array<[Partial<LoginProviderRecord>, string]> = [
      [{ clientId: null }, "draft"],
      [{ clientSecret: null }, "draft"],
      [{}, "needs_test"],
      // Passed, then the settings moved on.
      [{ testedConfigRevision: 2, testedAt: AT }, "needs_test"],
      [tested, "ready"],
      [{ ...tested, enabled: true }, "enabled"],
      [
        { ...tested, enabled: true, pendingClientSecret: SECRET },
        "enabled_secret_pending",
      ],
      // On is on, whatever the policy changes did to the revision since.
      [{ testedConfigRevision: 2, testedAt: AT, enabled: true }, "enabled"],
    ];
    for (const [over, state] of cases) {
      const { admin } = service({ rows: [record(over)] });
      const [provider] = (await admin.list(caller("owner"))).providers;
      expect(provider?.state, JSON.stringify(over)).toBe(state as never);
    }
  });

  test("discover reads the issuer's document now and says what the server would call", async () => {
    const { admin, asked } = service();
    expect(await admin.discover(caller("owner"), idp.issuer)).toEqual({
      outcome: "ok",
      endpoint_hosts: [new URL(idp.issuer).host],
      signing_algs: ["RS256"],
      token_auth_methods: expect.arrayContaining(["client_secret_post"]),
      pkce_advertised: expect.any(Boolean),
    });
    expect(asked).toEqual([]);
  });

  test("an issuer that cannot be used is answered as its problem, not as an error", async () => {
    const { admin } = service();
    // Nothing listens on the discard port.
    expect(
      await admin.discover(caller("owner"), "http://127.0.0.1:9/realms/none"),
    ).toEqual({ outcome: "failed", problem: "unreachable" });
    // The document names the provider's own issuer, not the one asked for.
    expect(
      await admin.discover(caller("owner"), `${idp.issuer}/elsewhere`),
    ).toMatchObject({ outcome: "failed" });
  });

  test("plain http is read only when the console itself is on loopback", async () => {
    const { admin } = service({
      consoleOrigin: "https://console.example.ts.net",
    });
    expect(await admin.discover(caller("owner"), idp.issuer)).toMatchObject({
      outcome: "failed",
    });
  });

  test("nothing is discovered or made while CONSOLE_ORIGIN is unset", async () => {
    const { admin, asked } = service({ consoleOrigin: null });
    const owner = caller("owner");
    for (const attempt of [
      admin.discover(owner, idp.issuer),
      admin.create(owner, { display_name: "Mock", issuer: idp.issuer }),
      admin.refreshDiscovery(owner, ID),
    ]) {
      expect((await refusal(attempt)).code).toBe("BACKEND_UNAVAILABLE");
    }
    expect(asked).toEqual([]);
  });

  test("create keeps what discovery named, under a new id, for the owner who asked", async () => {
    const { admin, asked } = service();
    const made = await admin.create(caller("owner"), {
      display_name: "Mock",
      issuer: idp.issuer,
    });
    expect(made.id).toBe(ID);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      method: "create",
      input: {
        displayName: "Mock",
        endpoints: {
          issuer: idp.issuer,
          authorizationEndpoint: `${idp.issuer}/authorize`,
          tokenEndpoint: `${idp.issuer}/token`,
          jwksUri: `${idp.issuer}/jwks`,
        },
        audit: { userId: USERS.owner, workspaceId: WORKSPACE },
      },
    });
    const input = asked[0]?.input as {
      id: string;
      audit: { receiptId: string };
    };
    expect(input.id).toMatch(UUID);
    expect(input.audit.receiptId).toMatch(UUID);
    expect(input.audit.receiptId).not.toBe(input.id);
  });

  test("create refuses an issuer that cannot be used or is already there", async () => {
    const unusable = service();
    expect(
      await refusal(
        unusable.admin.create(caller("owner"), {
          display_name: "None",
          issuer: "http://127.0.0.1:9/realms/none",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", details: { problem: "unreachable" } });
    expect(unusable.asked).toEqual([]);

    const taken = service({ answers: { create: { outcome: "issuer_taken" } } });
    expect(
      (
        await refusal(
          taken.admin.create(caller("owner"), {
            display_name: "Mock",
            issuer: idp.issuer,
          }),
        )
      ).code,
    ).toBe("ALREADY_EXISTS");
  });

  test("update names only what the request names, at the revision it was read", async () => {
    const { admin, asked } = service();
    await admin.update(caller("owner"), ID, '"5"', {
      display_name: "Renamed",
      client_id: "new-client",
      token_auth_method: "client_secret_post",
      allowed_domains: ["example.com", "example.org", "example.com"],
      jit_role: null,
      require_verified_email: false,
    });
    await admin.update(caller("owner"), ID, "5", { jit_role: "member" });
    expect(asked.map(({ input }) => input)).toMatchObject([
      {
        id: ID,
        ifMatch: 5,
        changes: {
          displayName: "Renamed",
          clientId: "new-client",
          tokenAuthMethod: "client_secret_post",
          allowedDomains: ["example.com", "example.org"],
          jitRole: null,
          requireVerifiedEmail: false,
        },
        audit: { userId: USERS.owner, workspaceId: WORKSPACE },
      },
      { id: ID, ifMatch: 5, changes: { jitRole: "member" } },
    ]);
    expect(
      Object.keys((asked[1]?.input as { changes: object }).changes),
    ).toEqual(["jitRole"]);
  });

  test("update needs If-Match, and says which refusal it met", async () => {
    const missing = service();
    expect(
      (
        await refusal(
          missing.admin.update(caller("owner"), ID, undefined, {
            display_name: "Renamed",
          }),
        )
      ).code,
    ).toBe("PRECONDITION_REQUIRED");
    expect(
      (
        await refusal(
          missing.admin.update(caller("owner"), ID, "latest", {
            display_name: "Renamed",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(missing.asked).toEqual([]);

    const cases: Array<[unknown, string, unknown]> = [
      [{ outcome: "not_found" }, "NOT_FOUND", null],
      [
        { outcome: "locked" },
        "REVISION_CONFLICT",
        { reason_code: "provider_enabled" },
      ],
      [
        { outcome: "stale", revision: 6 },
        "VERSION_MISMATCH",
        { current_version: 6 },
      ],
    ];
    for (const [answer, code, details] of cases) {
      const { admin } = service({ answers: { update: answer } });
      expect(
        await refusal(
          admin.update(caller("owner"), ID, "5", { client_id: "other" }),
        ),
      ).toEqual({ code: code as never, details: details as never });
    }
  });

  test("discovery is read again only for a provider that is off, and that is there", async () => {
    const on = service({ rows: [record({ enabled: true })] });
    expect(
      await refusal(on.admin.refreshDiscovery(caller("owner"), ID)),
    ).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "provider_enabled" },
    });
    expect(on.asked).toEqual([]);

    const none = service({ rows: [] });
    expect(
      (await refusal(none.admin.refreshDiscovery(caller("owner"), ID))).code,
    ).toBe("NOT_FOUND");

    const off = service({ rows: [record({ issuer: idp.issuer })] });
    await off.admin.refreshDiscovery(caller("owner"), ID);
    expect(off.asked).toMatchObject([
      {
        method: "refreshDiscovery",
        input: {
          id: ID,
          endpoints: {
            issuer: idp.issuer,
            tokenEndpoint: `${idp.issuer}/token`,
          },
          audit: { userId: USERS.owner, workspaceId: WORKSPACE },
        },
      },
    ]);

    // Turned on between the read and the write: the store's lock decides.
    const raced = service({
      rows: [record({ issuer: idp.issuer })],
      answers: { refreshDiscovery: { outcome: "locked" } },
    });
    expect(
      (await refusal(raced.admin.refreshDiscovery(caller("owner"), ID)))
        .details,
    ).toEqual({ reason_code: "provider_enabled" });

    const gone = service({ rows: [record()] });
    expect(
      await refusal(gone.admin.refreshDiscovery(caller("owner"), ID)),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(gone.asked).toEqual([]);
  });

  test("a client secret goes to the store and comes back as its last four characters", async () => {
    const { admin, asked } = service();
    const view = await admin.setClientSecret(
      caller("owner"),
      ID,
      "example-client-secret",
    );
    expect(asked).toMatchObject([
      {
        method: "setClientSecret",
        input: {
          id: ID,
          value: "example-client-secret",
          audit: { userId: USERS.owner, workspaceId: WORKSPACE },
        },
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("example-client-secret");
    expect(view.client_secret).toEqual({
      last4: "9f3a",
      updated_at: AT.toISOString(),
    });

    for (const [answer, code] of [
      [{ outcome: "not_found" }, "NOT_FOUND"],
      [{ outcome: "no_workspace" }, "BACKEND_UNAVAILABLE"],
    ] as const) {
      const refused = service({ answers: { setClientSecret: answer } });
      expect(
        (
          await refusal(
            refused.admin.setClientSecret(
              caller("owner"),
              ID,
              "another-secret",
            ),
          )
        ).code,
      ).toBe(code);
    }
  });

  test("a test sign-in is started for the owner's own console session", async () => {
    const { admin, started } = service();
    expect(await admin.startTest(caller("owner"), ID, SESSION)).toEqual({
      authorizationUrl: "https://idp/auth",
      cookieValue: "sealed",
    });
    expect(started).toEqual([
      { providerId: ID, userId: USERS.owner, sessionId: SESSION },
    ]);
    // No console session to bring the answer back to.
    expect(
      (await refusal(admin.startTest(caller("owner"), ID, undefined))).code,
    ).toBe("FORBIDDEN");
    expect(started).toHaveLength(1);
  });

  test("a test that cannot start says why", async () => {
    const cases: Array<[ProviderLoginError, string, unknown]> = [
      [
        new ProviderLoginError("not_found", "provider_missing"),
        "NOT_FOUND",
        null,
      ],
      [
        new ProviderLoginError("unavailable", "console_origin_unset"),
        "BACKEND_UNAVAILABLE",
        null,
      ],
      [
        new ProviderLoginError("unavailable", "client_not_configured"),
        "REVISION_CONFLICT",
        { reason_code: "not_tested" },
      ],
      [
        new ProviderLoginError(
          "unavailable",
          "authorization_endpoint_not_allowed",
        ),
        "BAD_REQUEST",
        { problem: "authorization_endpoint_not_allowed" },
      ],
    ];
    for (const [error, code, details] of cases) {
      const { admin } = service({
        startTest: async () => {
          throw error;
        },
      });
      expect(
        await refusal(admin.startTest(caller("owner"), ID, SESSION)),
      ).toEqual({ code: code as never, details: details as never });
    }
    // Anything else is not this service's to explain.
    const { admin } = service({
      startTest: async () => {
        throw new Error("boom");
      },
    });
    expect(admin.startTest(caller("owner"), ID, SESSION)).rejects.toThrow(
      "boom",
    );
  });

  test("turning on needs a passed test; turning off says how many sessions ended; only one that is off is deleted", async () => {
    const owner = caller("owner");
    const on = service({
      answers: {
        enable: {
          outcome: "enabled",
          provider: record({
            enabled: true,
            testedConfigRevision: 3,
            testedAt: AT,
          }),
        },
        disable: {
          outcome: "disabled",
          provider: record({ testedConfigRevision: 3, testedAt: AT }),
          sessionsRevoked: 4,
        },
      },
    });
    expect((await on.admin.enable(owner, ID)).state).toBe("enabled");
    const off = await on.admin.disable(owner, ID);
    expect(off.sessions_revoked).toBe(4);
    expect(off.provider.state).toBe("ready");
    await on.admin.remove(owner, ID);
    expect(on.asked.map(({ method, input }) => [method, input])).toMatchObject([
      ["enable", { id: ID, audit: { userId: USERS.owner } }],
      ["disable", { id: ID, audit: { userId: USERS.owner } }],
      ["delete", { id: ID, audit: { userId: USERS.owner } }],
    ]);
    // One receipt per change.
    const receipts = on.asked.map(
      ({ input }) =>
        (input as { audit: { receiptId: string } }).audit.receiptId,
    );
    expect(new Set(receipts).size).toBe(3);

    const refused = service({
      answers: {
        enable: { outcome: "not_ready" },
        disable: { outcome: "not_found" },
        delete: { outcome: "enabled" },
      },
    });
    expect(await refusal(refused.admin.enable(owner, ID))).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "not_tested" },
    });
    expect((await refusal(refused.admin.disable(owner, ID))).code).toBe(
      "NOT_FOUND",
    );
    expect(await refusal(refused.admin.remove(owner, ID))).toEqual({
      code: "REVISION_CONFLICT",
      details: { reason_code: "provider_enabled" },
    });

    const missing = service({
      answers: {
        enable: { outcome: "not_found" },
        delete: { outcome: "not_found" },
      },
    });
    expect((await refusal(missing.admin.enable(owner, ID))).code).toBe(
      "NOT_FOUND",
    );
    expect((await refusal(missing.admin.remove(owner, ID))).code).toBe(
      "NOT_FOUND",
    );
  });
});
