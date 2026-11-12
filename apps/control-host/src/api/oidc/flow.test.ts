import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { discover, type OidcEndpoints } from "./discovery.ts";
import {
  OidcRejectedError,
  type OidcRejection,
  OidcUnavailableError,
} from "./errors.ts";
import { finishFlow, type OidcClient, startFlow } from "./flow.ts";
import { authorizationParams, tokenIssuers } from "./issuer-rules.ts";
import type { NetworkPolicy } from "./provider-http.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  type FakeProvider,
  fakeProvider,
  ISSUER,
  makeSigner,
  REDIRECT_URI,
} from "./test-support/fake-provider.ts";

const POLICY: NetworkPolicy = { plainHttp: "refuse" };
const NOW = 1_800_000_000_000;

const client: OidcClient = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  tokenAuthMethod: "client_secret_basic",
  redirectUri: REDIRECT_URI,
};

async function begin(
  options: Parameters<typeof fakeProvider>[0] = {},
): Promise<{
  provider: FakeProvider;
  endpoints: OidcEndpoints;
  flow: ReturnType<typeof startFlow>;
}> {
  const provider = await fakeProvider(options);
  const endpoints = await discover(ISSUER, POLICY, provider.request);
  const flow = startFlow({ endpoints, client });
  provider.challenge = new URL(flow.authorizationUrl).searchParams.get(
    "code_challenge",
  );
  provider.claims = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "subject-1",
    iat: NOW / 1000 - 1,
    exp: NOW / 1000 + 300,
    nonce: flow.nonce,
    email: "Alice@Example.com",
    email_verified: true,
    name: "Alice",
  };
  provider.calls.length = 0;
  return { provider, endpoints, flow };
}

function finish(
  started: Awaited<ReturnType<typeof begin>>,
  overrides: Partial<Parameters<typeof finishFlow>[0]> = {},
) {
  return finishFlow({
    endpoints: started.endpoints,
    client,
    issuers: tokenIssuers(ISSUER),
    code: "good-code",
    nonce: started.flow.nonce,
    verifier: started.flow.verifier,
    requireVerifiedEmail: true,
    policy: POLICY,
    now: () => NOW,
    request: started.provider.request,
    ...overrides,
  });
}

async function reasonOf(run: Promise<unknown>): Promise<OidcRejection | "ok"> {
  try {
    await run;
  } catch (error) {
    if (error instanceof OidcRejectedError) return error.reason;
    throw error;
  }
  return "ok";
}

describe("OIDC flow start", () => {
  test("asks for a code with PKCE S256, a fresh state and nonce, and the fixed scope", async () => {
    const { endpoints } = await begin();
    const first = startFlow({ endpoints, client });
    const second = startFlow({ endpoints, client });
    const query = new URL(first.authorizationUrl).searchParams;
    expect(first.authorizationUrl.startsWith(`${ISSUER}/authorize?`)).toBe(
      true,
    );
    expect(Object.fromEntries(query)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      state: first.state,
      nonce: first.nonce,
      code_challenge: createHash("sha256")
        .update(first.verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    });
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    for (const name of ["state", "nonce", "verifier"] as const) {
      expect(first[name]).not.toBe(second[name]);
    }
    // The secret never travels through the browser.
    expect(first.authorizationUrl).not.toContain(CLIENT_SECRET);
  });

  test("keeps the provider's own query and adds per-issuer parameters", async () => {
    const { endpoints } = await begin();
    const flow = startFlow({
      endpoints: {
        ...endpoints,
        authorizationEndpoint: `${ISSUER}/authorize?tenant=a`,
      },
      client,
      extraParams: authorizationParams("https://accounts.google.com", [
        "example.com",
      ]),
    });
    const query = new URL(flow.authorizationUrl).searchParams;
    expect(query.get("tenant")).toBe("a");
    expect(query.get("hd")).toBe("example.com");
    expect(authorizationParams(ISSUER, ["example.com"])).toEqual({});
    expect(
      authorizationParams("https://accounts.google.com", ["a.com", "b.com"]),
    ).toEqual({});
  });
});

describe("OIDC flow finish", () => {
  test("exchanges the code with the verifier and returns the verified identity", async () => {
    const started = await begin();
    const identity = await finish(started);
    expect(identity).toMatchObject({
      issuer: ISSUER,
      subject: "subject-1",
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice",
    });
    const [token, jwks] = started.provider.calls;
    expect(started.provider.calls).toHaveLength(2);
    expect(token).toMatchObject({ url: `${ISSUER}/token`, method: "POST" });
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
      grant_type: "authorization_code",
      code: "good-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: started.flow.verifier,
    });
    expect(token?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(jwks?.url).toBe(`${ISSUER}/jwks`);
  });

  test("client_secret_post sends the secret in the body and no Authorization header", async () => {
    const started = await begin();
    await finish(started, {
      client: { ...client, tokenAuthMethod: "client_secret_post" },
    });
    const [token] = started.provider.calls;
    const form = new URLSearchParams(token?.body);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(token?.headers.Authorization).toBeUndefined();
  });

  test("a wrong PKCE verifier, a wrong code and a wrong secret are refused by the token endpoint, before any key is fetched", async () => {
    for (const overrides of [
      { verifier: "not-the-verifier-of-this-flow" },
      { code: "stolen-code" },
      { client: { ...client, clientSecret: "wrong" } },
    ]) {
      const started = await begin();
      expect(await reasonOf(finish(started, overrides))).toBe("code_refused");
      expect(started.provider.calls.map((call) => call.url)).toEqual([
        `${ISSUER}/token`,
      ]);
    }
  });

  test("a provider that does not check PKCE still gets the verifier, and every other check holds", async () => {
    const started = await begin();
    started.provider.challenge = null;
    expect(await reasonOf(finish(started))).toBe("ok");
    const sent = new URLSearchParams(started.provider.calls[0]?.body);
    expect(sent.get("code_verifier")).toBe(started.flow.verifier);

    const replayed = await begin();
    replayed.provider.challenge = null;
    replayed.provider.claims.nonce = "nonce-of-another-flow";
    expect(await reasonOf(finish(replayed))).toBe("nonce_mismatch");
  });

  test("the id_token is verified: another audience, an expired token and a wrong signature are refused", async () => {
    const audience = await begin();
    audience.provider.claims.aud = "someone-else";
    expect(await reasonOf(finish(audience))).toBe("audience_mismatch");

    const expired = await begin();
    expired.provider.claims.exp = NOW / 1000 - 1;
    expect(await reasonOf(finish(expired))).toBe("expired");

    const forged = await begin();
    const stranger = await makeSigner("RS256");
    forged.provider.signer = stranger;
    forged.provider.tokenHeader = { kid: forged.provider.keys[0]?.kid };
    expect(await reasonOf(finish(forged))).toBe("bad_signature");
  });

  test("the clock is read after the provider answered: a token that expired during the wait is refused", async () => {
    const started = await begin();
    started.provider.claims.exp = NOW / 1000 + 1;
    let clock = NOW;
    const original = started.provider.request;
    const run = finish(started, {
      now: () => clock,
      request: async (url, init, policy) => {
        const response = await original(url, init, policy);
        // The key fetch is the last thing before the claims are read.
        if (url.endsWith("/jwks")) clock = NOW + 1200;
        return response;
      },
    });
    expect(await reasonOf(run)).toBe("expired");
    // The same token read in time is good.
    const inTime = await begin();
    inTime.provider.claims.exp = NOW / 1000 + 1;
    expect(await reasonOf(finish(inTime))).toBe("ok");
  });

  test("keys are read on every sign-in, so a rotated key works at once and a removed one stops at once", async () => {
    const started = await begin();
    const next = await makeSigner("ES256");
    started.provider.signer = next;
    expect(await reasonOf(finish(started))).toBe("no_matching_key");
    started.provider.keys = [next.jwk];
    expect(await reasonOf(finish(started))).toBe("ok");
  });

  test("a token signed with an algorithm discovery did not offer is refused", async () => {
    const started = await begin({
      discovery: { id_token_signing_alg_values_supported: ["RS256"] },
    });
    const ec = await makeSigner("ES256");
    started.provider.signer = ec;
    started.provider.keys = [ec.jwk];
    expect(await reasonOf(finish(started))).toBe("alg_not_allowed");
  });

  test("a token response without an id_token is refused", async () => {
    const started = await begin();
    const original = started.provider.request;
    expect(
      await reasonOf(
        finish(started, {
          request: async (url, init, policy) =>
            url.endsWith("/token")
              ? { status: 200, text: JSON.stringify({ access_token: "a" }) }
              : original(url, init, policy),
        }),
      ),
    ).toBe("no_id_token");
  });

  describe("authorization response issuer (RFC 9207)", () => {
    test("is required when the provider advertises it and must be this issuer", async () => {
      const started = await begin({
        discovery: { authorization_response_iss_parameter_supported: true },
      });
      expect(await reasonOf(finish(started))).toBe("response_issuer_mismatch");
      expect(
        await reasonOf(
          finish(started, { responseIssuer: "https://evil.example" }),
        ),
      ).toBe("response_issuer_mismatch");
      expect(started.provider.calls).toHaveLength(0);
      expect(await reasonOf(finish(started, { responseIssuer: ISSUER }))).toBe(
        "ok",
      );
    });

    test("when present it is checked even if the provider did not advertise it", async () => {
      const started = await begin();
      expect(
        await reasonOf(
          finish(started, { responseIssuer: "https://evil.example" }),
        ),
      ).toBe("response_issuer_mismatch");
      expect(await reasonOf(finish(started, { responseIssuer: ISSUER }))).toBe(
        "ok",
      );
    });
  });

  describe("email", () => {
    const table: [
      string,
      Record<string, unknown>,
      boolean,
      OidcRejection | { email: string | null; emailVerified: boolean | null },
    ][] = [
      [
        "verified, required",
        { email_verified: true },
        true,
        { email: "alice@example.com", emailVerified: true },
      ],
      [
        "explicitly unverified, required",
        { email_verified: false },
        true,
        "email_unverified",
      ],
      [
        "explicitly unverified, not required",
        { email_verified: false },
        false,
        "email_unverified",
      ],
      [
        "no email_verified, required",
        { email_verified: undefined },
        true,
        "email_unverified",
      ],
      [
        "no email_verified, not required",
        { email_verified: undefined },
        false,
        { email: "alice@example.com", emailVerified: null },
      ],
      [
        "email_verified as text, required",
        { email_verified: "true" },
        true,
        "email_unverified",
      ],
      ["no email, required", { email: undefined }, true, "email_unverified"],
      [
        "no email, not required",
        { email: undefined, email_verified: undefined },
        false,
        { email: null, emailVerified: null },
      ],
    ];
    for (const [what, claims, required, expected] of table) {
      test(`${what}`, async () => {
        const started = await begin();
        Object.assign(started.provider.claims, claims);
        // UserInfo knows no more about this person than the id_token does.
        started.provider.userinfo = { sub: "subject-1" };
        const run = finish(started, { requireVerifiedEmail: required });
        if (typeof expected === "string") {
          expect(await reasonOf(run)).toBe(expected);
        } else {
          expect(await run).toMatchObject(expected);
        }
      });
    }
  });

  describe("UserInfo for a thin id_token", () => {
    async function thin() {
      const started = await begin();
      started.provider.claims.email = undefined;
      started.provider.claims.email_verified = undefined;
      return started;
    }

    test("fills in the email with the access token when the id_token has none", async () => {
      const started = await thin();
      started.provider.userinfo = {
        sub: "subject-1",
        email: "Alice@Example.com",
        email_verified: true,
      };
      expect(await finish(started)).toMatchObject({
        email: "alice@example.com",
        emailVerified: true,
      });
      const userinfo = started.provider.calls[2];
      expect(userinfo?.url).toBe(`${ISSUER}/userinfo`);
      expect(userinfo?.headers.Authorization).toBe("Bearer access-token-value");
    });

    test("the id_token's own 'not verified' is not overruled by UserInfo, and UserInfo is not asked", async () => {
      for (const required of [true, false]) {
        const started = await thin();
        started.provider.claims.email_verified = false;
        started.provider.userinfo = {
          sub: "subject-1",
          email: "alice@example.com",
          email_verified: true,
        };
        expect(
          await reasonOf(finish(started, { requireVerifiedEmail: required })),
        ).toBe("email_unverified");
        expect(started.provider.calls.map((call) => call.url)).toEqual([
          `${ISSUER}/token`,
          `${ISSUER}/jwks`,
        ]);
      }
    });

    test("UserInfo's 'not verified' is a refusal whatever the setting", async () => {
      for (const required of [true, false]) {
        const started = await thin();
        started.provider.userinfo = {
          sub: "subject-1",
          email: "alice@example.com",
          email_verified: false,
        };
        expect(
          await reasonOf(finish(started, { requireVerifiedEmail: required })),
        ).toBe("email_unverified");
      }
    });

    test("an answer about another subject is refused", async () => {
      const started = await thin();
      started.provider.userinfo = {
        sub: "someone-else",
        email: "victim@example.com",
        email_verified: true,
      };
      expect(await reasonOf(finish(started))).toBe("userinfo_subject_mismatch");
    });

    test("a refusal by UserInfo is a refusal of the sign-in", async () => {
      const started = await thin();
      started.provider.userinfo = null;
      expect(await reasonOf(finish(started))).toBe("userinfo_refused");
    });

    test("its unverified email is refused like the id_token's", async () => {
      const started = await thin();
      started.provider.userinfo = {
        sub: "subject-1",
        email: "alice@example.com",
        email_verified: false,
      };
      expect(
        await reasonOf(finish(started, { requireVerifiedEmail: false })),
      ).toBe("email_unverified");
    });

    test("is not called when the id_token already carries the email, or the provider has no UserInfo", async () => {
      const full = await begin();
      await finish(full);
      expect(full.provider.calls).toHaveLength(2);

      const none = await thin();
      expect(
        await finish(none, {
          endpoints: { ...none.endpoints, userinfoEndpoint: null },
          requireVerifiedEmail: false,
        }),
      ).toMatchObject({ email: null });
      expect(none.provider.calls).toHaveLength(2);
    });
  });

  test("a provider that is down is unavailable, not a refusal", async () => {
    const started = await begin();
    await expect(
      finish(started, {
        request: async () => {
          throw new OidcUnavailableError("answered", "Provider answered 503");
        },
      }),
    ).rejects.toBeInstanceOf(OidcUnavailableError);
  });

  test("Google's two issuer spellings are both listed, any other issuer only itself", () => {
    expect(tokenIssuers("https://accounts.google.com")).toEqual([
      "https://accounts.google.com",
      "accounts.google.com",
    ]);
    expect(tokenIssuers(ISSUER)).toEqual([ISSUER]);
  });
});
