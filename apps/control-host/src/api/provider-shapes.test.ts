import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { LOGIN_FLOW_COOKIE_NAME } from "@werft-ai/contracts";
import type { LoginProvider, LoginProviderStore } from "@werft-ai/platform";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { createFlowSealer } from "./oidc/flow-cookie.ts";
import {
  createProviderRequest,
  discover,
  GOOGLE_ISSUER,
  OidcDiscoveryError,
  type OidcEndpoints,
  type ProviderRequest,
} from "./oidc/index.ts";
import {
  createProviderLogin,
  networkPolicyFor,
  type ProviderLogin,
  ProviderLoginError,
} from "./provider-login.ts";

// The providers of design section 10, each a stand-in with that provider's
// shape: where its issuer lives, what its discovery document lists, how it
// signs, what it says about the address. Each goes the way an owner and then
// a person take: discovery, the row kept from it, a sign-in. The server's
// requests run the production request path under the production network
// policy (https only); only the last hop is turned to the stand-in.
//
// A sign-in here ends with who the provider says it is and how the provider's
// rules take them (`ownsEmail`, `jitRole`). What the store makes of that
// (rules 1 to 5, an invite's token) is the same for every provider and is
// pinned in provider-login.integration.test.ts.

const CLIENT_ID = "werft-console";
const CLIENT_SECRET = randomBytes(24).toString("base64url");
const CONSOLE_ORIGIN = "https://console.example.com";
const POLICY = networkPolicyFor(CONSOLE_ORIGIN);
const PROVIDER_ID = randomUUID();
const INVITE_ID = randomUUID();
const FLOW_KEY = randomBytes(32);
const sealer = createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME);

type Shape = Omit<
  Parameters<typeof startMockOidcServer>[0],
  "clientId" | "clientSecret" | "issuer" | "publicUrl"
>;

const standIns: MockOidcServer[] = [];
afterAll(() => {
  for (const idp of standIns) idp.stop();
});

async function standIn(issuer: string, shape: Shape = {}) {
  const idp = await startMockOidcServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    issuer,
    publicUrl: issuer,
    ...shape,
  });
  standIns.push(idp);
  return idp;
}

/** The server's requests, each landing on the stand-in `pick` names. */
function requestTo(pick: (path: string) => MockOidcServer): ProviderRequest {
  return createProviderRequest({
    // Any public address: it is judged, never connected to.
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: ((target: URL | string, init?: RequestInit) => {
      const { pathname, search } = new URL(String(target));
      return fetch(
        `http://127.0.0.1:${pick(pathname).port}${pathname}${search}`,
        {
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body == null ? {} : { body: init.body }),
          redirect: "manual",
          ...(init?.signal == null ? {} : { signal: init.signal }),
        },
      );
    }) as unknown as typeof fetch,
  });
}

/**
 * The row a new provider is kept as: what discovery named, the first client
 * authentication it lists, and the owner's settings.
 */
function providerOf(
  endpoints: OidcEndpoints,
  settings: Partial<LoginProvider> = {},
): LoginProvider {
  const { tokenAuthMethods, pkceAdvertised: _, ...named } = endpoints;
  return {
    id: PROVIDER_ID,
    displayName: "Stand-in",
    ...named,
    clientId: CLIENT_ID,
    tokenAuthMethod: tokenAuthMethods[0] ?? "client_secret_basic",
    allowedDomains: [],
    jitRole: null,
    requireVerifiedEmail: true,
    enabled: true,
    configRevision: 1,
    ...settings,
  };
}

function loginWith(
  row: LoginProvider,
  request: ProviderRequest,
  clientSecret = CLIENT_SECRET,
): ProviderLogin {
  const providers: LoginProviderStore = {
    listEnabled: async () => [],
    findForSignIn: async (id) =>
      id === row.id ? { provider: { ...row }, clientSecret } : null,
  };
  return createProviderLogin({
    providers,
    consoleOrigin: CONSOLE_ORIGIN,
    flowKey: FLOW_KEY,
    request,
  });
}

type Started = Awaited<ReturnType<ProviderLogin["start"]>>;
type Callback = Parameters<ProviderLogin["finish"]>[0];

/** The person goes to the provider and comes back with its answer. */
async function comeBack(
  idp: MockOidcServer,
  started: Started,
  claims: MockOidcClaims,
): Promise<Callback> {
  const answer = await idp.authorize(started.authorizationUrl, claims);
  return {
    cookieValue: started.cookieValue,
    providerId: PROVIDER_ID,
    code: answer.code,
    state: answer.state,
    responseIssuer: answer.iss,
  };
}

const signIn = async (
  login: ProviderLogin,
  idp: MockOidcServer,
  claims: MockOidcClaims,
) => login.finish(await comeBack(idp, await login.start(PROVIDER_ID), claims));

const signUpByInvite = async (
  login: ProviderLogin,
  idp: MockOidcServer,
  claims: MockOidcClaims,
) =>
  login.finishInvite(
    await comeBack(
      idp,
      await login.startInvite({ providerId: PROVIDER_ID, inviteId: INVITE_ID }),
      claims,
    ),
  );

/** Who signed in and how they may come in: what the store is handed. */
const who = ({
  identity,
  admission,
}: Awaited<ReturnType<ProviderLogin["finish"]>>) => ({
  issuer: identity.issuer,
  subject: identity.subject,
  email: identity.email,
  emailVerified: identity.emailVerified,
  ...admission,
});

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

const JIT = { jitRole: "member" as const };
const UNVERIFIED = { kind: "rejected", reason: "email_unverified" } as const;

describe("Google: one issuer for everyone, `hd` on a Workspace account, `iss` with or without the scheme", () => {
  // The lists of https://accounts.google.com/.well-known/openid-configuration
  // as read on 2026-11-13.
  const DISCOVERY = {
    userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    response_types_supported: [
      "code",
      "token",
      "id_token",
      "code token",
      "code id_token",
      "token id_token",
      "code token id_token",
      "none",
    ],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
    code_challenge_methods_supported: ["plain", "S256"],
    authorization_response_iss_parameter_supported: true,
  };
  const WORKSPACE = { allowedDomains: ["acme.example"], ...JIT };
  const dana: MockOidcClaims = {
    sub: "110169484474386276334",
    email: "dana@acme.example",
    hd: "acme.example",
    name: "Dana",
  };
  let idp: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    idp = await standIn(GOOGLE_ISSUER, { discovery: DISCOVERY });
    request = requestTo(() => idp);
    endpoints = await discover(GOOGLE_ISSUER, POLICY, request);
  });

  test("discovery is kept as RS256, and the authorization response has to name the issuer", () => {
    expect(endpoints).toMatchObject({
      issuer: GOOGLE_ISSUER,
      signingAlgs: ["RS256"],
      tokenAuthMethods: ["client_secret_basic", "client_secret_post"],
      issParameterRequired: true,
      pkceAdvertised: true,
    });
  });

  test("a Workspace account signs in and joins by itself on an allowed domain, whichever way the token spells the issuer", async () => {
    const login = loginWith(providerOf(endpoints, WORKSPACE), request);
    const { authorizationUrl } = await login.start(PROVIDER_ID);
    expect(new URL(authorizationUrl).searchParams.get("hd")).toBe(
      "acme.example",
    );
    for (const iss of [GOOGLE_ISSUER, "accounts.google.com"]) {
      expect(who(await signIn(login, idp, { ...dana, iss }))).toEqual({
        issuer: GOOGLE_ISSUER,
        subject: dana.sub,
        email: "dana@acme.example",
        emailVerified: true,
        ownsEmail: true,
        jitRole: "member",
      });
    }
  });

  test("an invite's token signs the same account up", async () => {
    const login = loginWith(providerOf(endpoints), request);
    const signedUp = await signUpByInvite(login, idp, dana);
    expect(signedUp.inviteId).toBe(INVITE_ID);
    expect(who(signedUp)).toMatchObject({ subject: dana.sub, ownsEmail: true });
  });

  test("an account Google does not place in an allowed domain stays out, its address notwithstanding", async () => {
    const login = loginWith(providerOf(endpoints, WORKSPACE), request);
    for (const outside of [
      { ...dana, hd: null },
      { ...dana, hd: "elsewhere.example" },
      { ...dana, email: "dana@gmail.com", hd: null },
    ]) {
      expect(await refusal(signIn(login, idp, outside))).toEqual({
        kind: "forbidden",
        reason: "domain_not_allowed",
      });
    }
  });

  test("a callback that does not name the issuer is refused", async () => {
    const login = loginWith(providerOf(endpoints), request);
    const callback = await comeBack(idp, await login.start(PROVIDER_ID), dana);
    expect(callback.responseIssuer).toBe(GOOGLE_ISSUER);
    expect(
      await refusal(login.finish({ ...callback, responseIssuer: undefined })),
    ).toEqual({ kind: "rejected", reason: "response_issuer_mismatch" });
  });
});

describe("OneLogin: an issuer under a path, one client authentication per app, no `email_verified`", () => {
  const ISSUER = "https://example.onelogin.com/oidc/2";
  const sam: MockOidcClaims = {
    sub: "48211357",
    email: "sam@acme.example",
    email_verified: null,
    name: "Sam",
  };
  const POST = { tokenAuthMethod: "client_secret_post" as const };
  let idp: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    idp = await standIn(ISSUER, {
      // The app is set to POST.
      clientAuth: "client_secret_post",
      discovery: {
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
      },
    });
    request = requestTo(() => idp);
    endpoints = await discover(ISSUER, POLICY, request);
  });

  test("the authentication discovery lists first is refused by an app set to the other; the one the owner picks works", async () => {
    const settings = { requireVerifiedEmail: false };
    expect(providerOf(endpoints).tokenAuthMethod).toBe("client_secret_basic");
    expect(
      await refusal(
        signIn(loginWith(providerOf(endpoints, settings), request), idp, sam),
      ),
    ).toEqual({ kind: "rejected", reason: "code_refused" });
    const login = loginWith(
      providerOf(endpoints, { ...settings, ...POST }),
      request,
    );
    expect(who(await signIn(login, idp, sam)).subject).toBe(sam.sub);
  });

  test("with no word on the address, nobody signs in while a verified address is required", async () => {
    const login = loginWith(providerOf(endpoints, POST), request);
    expect(await refusal(signIn(login, idp, sam))).toEqual(UNVERIFIED);
    expect(await refusal(signUpByInvite(login, idp, sam))).toEqual(UNVERIFIED);
  });

  test("without that requirement the account signs in and an invite's token signs it up, and its address joins nobody", async () => {
    const login = loginWith(
      providerOf(endpoints, { ...POST, ...JIT, requireVerifiedEmail: false }),
      request,
    );
    const unvouched = {
      issuer: ISSUER,
      subject: sam.sub,
      email: "sam@acme.example",
      emailVerified: null,
      ownsEmail: false,
      jitRole: null,
    };
    expect(who(await signIn(login, idp, sam))).toEqual(unvouched);
    const signedUp = await signUpByInvite(login, idp, sam);
    expect(signedUp.inviteId).toBe(INVITE_ID);
    expect(who(signedUp)).toEqual(unvouched);
  });

  test("once the admin adds `email_verified` to the token, the address counts and joins by itself", async () => {
    const login = loginWith(
      providerOf(endpoints, { ...POST, ...JIT }),
      request,
    );
    expect(
      who(await signIn(login, idp, { ...sam, email_verified: true })),
    ).toMatchObject({
      emailVerified: true,
      ownsEmail: true,
      jitRole: "member",
    });
  });
});

describe("Entra ID: a tenant's issuer, no `email_verified`, an `email` only when the app registration adds it", () => {
  const ISSUER = `https://login.microsoftonline.com/${randomUUID()}/v2.0`;
  // The lists of the v2.0 discovery document as read on 2026-11-13: no
  // word on PKCE, and a UserInfo endpoint (Microsoft Graph's there, the
  // stand-in's own here).
  const DISCOVERY = {
    userinfo_endpoint: `${ISSUER}/userinfo`,
    response_types_supported: [
      "code",
      "id_token",
      "code id_token",
      "id_token token",
    ],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "private_key_jwt",
      "client_secret_basic",
      "self_signed_tls_client_auth",
    ],
    code_challenge_methods_supported: null,
  };
  const lee: MockOidcClaims = {
    sub: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ",
    email: "lee@acme.example",
    email_verified: null,
    name: "Lee",
  };
  const OPEN = { requireVerifiedEmail: false, ...JIT };
  let idp: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    idp = await standIn(ISSUER, { discovery: DISCOVERY });
    request = requestTo(() => idp);
    endpoints = await discover(ISSUER, POLICY, request);
  });

  test("the tenant's endpoints are found under its path; PKCE is not advertised and is sent all the same", async () => {
    expect(endpoints).toMatchObject({
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/token`,
      signingAlgs: ["RS256"],
      pkceAdvertised: false,
    });
    const { authorizationUrl } = await loginWith(
      providerOf(endpoints),
      request,
    ).start(PROVIDER_ID);
    expect(
      new URL(authorizationUrl).searchParams.get("code_challenge_method"),
    ).toBe("S256");
  });

  test("the `common` issuer names a template in its own document and is refused at discovery", async () => {
    const common = "https://login.microsoftonline.com/common/v2.0";
    const shared = await standIn(common, {
      discovery: {
        ...DISCOVERY,
        issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      },
    });
    const problem = await discover(
      common,
      POLICY,
      requestTo(() => shared),
    ).catch((error: unknown) => error);
    expect(problem).toBeInstanceOf(OidcDiscoveryError);
    expect((problem as OidcDiscoveryError).problem).toBe("issuer_mismatch");
  });

  test("nobody signs in while a verified address is required", async () => {
    const login = loginWith(providerOf(endpoints, JIT), request);
    expect(await refusal(signIn(login, idp, lee))).toEqual(UNVERIFIED);
  });

  test("without that requirement the account signs in and an invite's token signs it up, with or without an address, and joins nobody", async () => {
    const login = loginWith(providerOf(endpoints, OPEN), request);
    // Without an address in the token UserInfo is asked, and has none to
    // add.
    for (const [claims, email] of [
      [lee, "lee@acme.example"],
      [{ ...lee, email: null }, null],
    ] as const) {
      const unvouched = {
        issuer: ISSUER,
        subject: lee.sub,
        email,
        emailVerified: null,
        ownsEmail: false,
        jitRole: null,
      };
      expect(who(await signIn(login, idp, claims))).toEqual(unvouched);
      expect(who(await signUpByInvite(login, idp, claims))).toEqual(unvouched);
    }
  });
});

describe("Okta: a thin id_token, the scope's claims from UserInfo", () => {
  const ISSUER = "https://example.okta.com/oauth2/default";
  const kim: MockOidcClaims = {
    sub: "00u1a2b3c4d5e6f7g8h9",
    email: "kim@acme.example",
    name: "Kim",
  };
  let idp: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    idp = await standIn(ISSUER, {
      thinIdToken: true,
      discovery: {
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "client_secret_jwt",
          "private_key_jwt",
          "none",
        ],
      },
    });
    request = requestTo(() => idp);
    endpoints = await discover(ISSUER, POLICY, request);
  });

  test("the address UserInfo vouches for signs in, takes an invite's token and joins by itself", async () => {
    expect(endpoints.userinfoEndpoint).toBe(`${ISSUER}/userinfo`);
    const login = loginWith(providerOf(endpoints, JIT), request);
    const vouched = {
      issuer: ISSUER,
      subject: kim.sub,
      email: "kim@acme.example",
      emailVerified: true,
      ownsEmail: true,
      jitRole: "member",
    } as const;
    const signedIn = await signIn(login, idp, kim);
    // The address is UserInfo's: the token itself has none.
    expect(signedIn.identity.claims.email).toBeUndefined();
    expect(who(signedIn)).toEqual(vouched);
    expect(who(await signUpByInvite(login, idp, kim))).toEqual(vouched);
  });

  test("UserInfo saying the address is not verified is believed, whatever the setting", async () => {
    const login = loginWith(
      providerOf(endpoints, { requireVerifiedEmail: false }),
      request,
    );
    expect(
      await refusal(signIn(login, idp, { ...kim, email_verified: false })),
    ).toEqual(UNVERIFIED);
  });

  test("a provider kept without its UserInfo endpoint has no address to go by", async () => {
    const login = loginWith(
      providerOf(endpoints, { userinfoEndpoint: null }),
      request,
    );
    expect(await refusal(signIn(login, idp, kim))).toEqual(UNVERIFIED);
  });
});

describe("Keycloak: a realm's issuer, ES256, `email_verified: false` for an unverified user", () => {
  const ISSUER = "https://sso.acme.example/realms/werft";
  const ana: MockOidcClaims = {
    sub: "6f1d7a0e-58a4-4e6b-9c1f-2f0f8b7d3c55",
    email: "ana@acme.example",
    name: "Ana",
  };
  let idp: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    idp = await standIn(ISSUER, {
      signingAlg: "ES256",
      discovery: {
        id_token_signing_alg_values_supported: [
          "PS384",
          "RS384",
          "EdDSA",
          "ES384",
          "HS256",
          "HS512",
          "ES256",
          "RS256",
          "HS384",
          "ES512",
          "PS256",
          "PS512",
          "RS512",
        ],
        token_endpoint_auth_methods_supported: [
          "private_key_jwt",
          "client_secret_basic",
          "client_secret_post",
          "tls_client_auth",
          "client_secret_jwt",
        ],
        code_challenge_methods_supported: ["plain", "S256"],
        authorization_response_iss_parameter_supported: true,
      },
    });
    request = requestTo(() => idp);
    endpoints = await discover(ISSUER, POLICY, request);
  });

  test("of the algorithms a realm lists only RS256 and ES256 are kept, and an ES256 token signs in, takes an invite's token and joins", async () => {
    expect(endpoints).toMatchObject({
      issuer: ISSUER,
      signingAlgs: ["RS256", "ES256"],
      issParameterRequired: true,
    });
    const login = loginWith(providerOf(endpoints, JIT), request);
    const vouched = {
      issuer: ISSUER,
      subject: ana.sub,
      email: "ana@acme.example",
      emailVerified: true,
      ownsEmail: true,
      jitRole: "member",
    } as const;
    expect(who(await signIn(login, idp, ana))).toEqual(vouched);
    expect(who(await signUpByInvite(login, idp, ana))).toEqual(vouched);
  });

  test("a user whose address is not verified is refused, whatever the setting", async () => {
    const login = loginWith(
      providerOf(endpoints, { requireVerifiedEmail: false }),
      request,
    );
    const unverified = { ...ana, email_verified: false };
    expect(await refusal(signIn(login, idp, unverified))).toEqual(UNVERIFIED);
    expect(await refusal(signUpByInvite(login, idp, unverified))).toEqual(
      UNVERIFIED,
    );
  });
});

describe("a provider that rotates its signing key", () => {
  const ISSUER = "https://rotating.example/oidc";
  const pat: MockOidcClaims = { sub: "7001", email: "pat@acme.example" };

  test("the next sign-in is checked against the new key, with nothing kept from the old one", async () => {
    const idp = await standIn(ISSUER);
    const request = requestTo(() => idp);
    const login = loginWith(
      providerOf(await discover(ISSUER, POLICY, request)),
      request,
    );
    const kidOf = async () =>
      (
        JSON.parse((await request(`${ISSUER}/jwks`, {}, POLICY)).text) as {
          keys: { kid: string }[];
        }
      ).keys.map((key) => key.kid);
    const [before] = await kidOf();
    expect((await signIn(login, idp, pat)).identity.subject).toBe(pat.sub);

    // Between the person's leaving for the provider and their coming back.
    const callback = await comeBack(idp, await login.start(PROVIDER_ID), pat);
    await idp.rotateKeys();
    const after = await kidOf();
    expect(after.length).toBe(1);
    expect(after).not.toContain(before);
    expect((await login.finish(callback)).identity.subject).toBe(pat.sub);
  });
});

// Whether a wrong verifier is refused is the provider's doing. This pins
// what still holds at one that does not look; it is not the evidence that
// PKCE is enforced, which is the stand-in that checks and a real Keycloak.
describe("a provider that does not check PKCE for a client with a secret", () => {
  const STRICT = "https://strict.example/oidc";
  const LAX = "https://lax.example/oidc";
  const pat: MockOidcClaims = { sub: "7001", email: "pat@acme.example" };
  let strict: MockOidcServer;
  let lax: MockOidcServer;
  /** Says it is the lax provider and signs with keys that one does not publish. */
  let stranger: MockOidcServer;
  let request: ProviderRequest;
  let endpoints: OidcEndpoints;
  beforeAll(async () => {
    strict = await standIn(STRICT);
    lax = await standIn(LAX, { checksPkce: false });
    stranger = await standIn(LAX, { checksPkce: false });
    request = requestTo(() => lax);
    endpoints = await discover(LAX, POLICY, request);
  });

  /** The same callback, its flow holding a verifier the challenge was not made from. */
  const withAnotherVerifier = (callback: Callback): Callback => {
    const flow = sealer.open(callback.cookieValue);
    if (flow === null) throw new Error("the flow cookie did not open");
    return {
      ...callback,
      cookieValue: sealer.seal({
        ...flow,
        verifier: randomBytes(32).toString("base64url"),
      }),
    };
  };

  test("a wrong verifier is refused by the provider that checks, and passes here", async () => {
    const checked = requestTo(() => strict);
    const careful = loginWith(
      providerOf(await discover(STRICT, POLICY, checked)),
      checked,
    );
    expect(
      await refusal(
        careful.finish(
          withAnotherVerifier(
            await comeBack(strict, await careful.start(PROVIDER_ID), pat),
          ),
        ),
      ),
    ).toEqual({ kind: "rejected", reason: "code_refused" });

    const login = loginWith(providerOf(endpoints), request);
    const signedIn = await login.finish(
      withAnotherVerifier(
        await comeBack(lax, await login.start(PROVIDER_ID), pat),
      ),
    );
    expect(signedIn.identity.subject).toBe(pat.sub);
  });

  test("the flow's state and the token's nonce are still held to", async () => {
    const login = loginWith(providerOf(endpoints), request);
    const callback = await comeBack(lax, await login.start(PROVIDER_ID), pat);
    expect(
      await refusal(login.finish({ ...callback, state: `${callback.state}x` })),
    ).toEqual({ kind: "rejected", reason: "state_mismatch" });
    expect(
      await refusal(signIn(login, lax, { ...pat, nonce: "another" })),
    ).toEqual({ kind: "rejected", reason: "nonce_mismatch" });
  });

  test("a wrong client secret is still refused", async () => {
    const login = loginWith(
      providerOf(endpoints),
      request,
      randomBytes(24).toString("base64url"),
    );
    expect(await refusal(signIn(login, lax, pat))).toEqual({
      kind: "rejected",
      reason: "code_refused",
    });
  });

  test("a token signed with a key the provider does not publish is still refused", async () => {
    // The code is redeemed at the stranger; the keys are read from the
    // provider.
    const crossed = requestTo((path) =>
      path.endsWith("/token") ? stranger : lax,
    );
    const login = loginWith(providerOf(endpoints), crossed);
    expect(await refusal(signIn(login, stranger, pat))).toEqual({
      kind: "rejected",
      reason: "no_matching_key",
    });
  });

  test("a token for another client, from another issuer, or past its time is still refused", async () => {
    const login = loginWith(providerOf(endpoints), request);
    for (const [claims, reason] of [
      [{ aud: "another-client" }, "audience_mismatch"],
      [{ iss: "https://elsewhere.example/oidc" }, "issuer_mismatch"],
      [{ exp: 1 }, "expired"],
    ] as const) {
      expect(await refusal(signIn(login, lax, { ...pat, ...claims }))).toEqual({
        kind: "rejected",
        reason,
      });
    }
  });
});
