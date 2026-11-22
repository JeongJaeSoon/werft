import { describe, expect, test } from "bun:test";
import {
  FAKE_ISSUER,
  FAKE_MCP_URL,
  type FakeRemoteOptions,
  fakeRemote,
} from "../testing/workspace-mcp-fakes.ts";
import type { WorkspaceMcpOAuthPin } from "./ports/workspace-mcp-store.ts";
import {
  bearerChallengeOf,
  discover,
  exchangeCode,
  listTools,
  manualAuthMethod,
  registerClient,
  scopeWidens,
  WorkspaceMcpRemoteError,
} from "./remote.ts";

const FAKE_TOKEN = "example-token-not-real";

async function reasonOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof WorkspaceMcpRemoteError) return error.reason;
    throw error;
  }
  return "answered normally";
}

const deps = (options: FakeRemoteOptions = {}) => {
  const remote = fakeRemote(options);
  return { remote, deps: { http: remote.http, allowsUrl: remote.allowsUrl } };
};

describe("bearerChallengeOf", () => {
  test("reads quoted and bare parameters, the first of each name", () => {
    expect(
      bearerChallengeOf(
        'Bearer realm="x", resource_metadata="https://a.example/m", scope=read resource_metadata="https://b.example"',
      ),
    ).toEqual({ resourceMetadata: "https://a.example/m", scope: "read" });
    expect(bearerChallengeOf('Basic realm="x"')).toEqual({
      resourceMetadata: null,
      scope: null,
    });
    expect(bearerChallengeOf(null)).toEqual({
      resourceMetadata: null,
      scope: null,
    });
  });
});

describe("scopeWidens", () => {
  test("a token outside the allowed set widens; order and spacing do not", () => {
    expect(scopeWidens("b a", "a b")).toBe(false);
    expect(scopeWidens("a  b", "a b")).toBe(false);
    expect(scopeWidens("a c", "a b")).toBe(true);
    expect(scopeWidens("anything", null)).toBe(false);
  });
});

describe("discover", () => {
  test("a server with no resource metadata takes a static token", async () => {
    const { deps: d } = deps({ oauth: false });
    expect(await discover(d, FAKE_MCP_URL)).toEqual({
      url: FAKE_MCP_URL,
      oauth: null,
    });
  });

  test("the pin keeps every endpoint and the resource", async () => {
    const { deps: d } = deps();
    const found = await discover(d, FAKE_MCP_URL);
    expect(found.oauth?.pin).toMatchObject({
      issuer: FAKE_ISSUER,
      tokenEndpoint: `${FAKE_ISSUER}/token`,
      revocationEndpoint: `${FAKE_ISSUER}/revoke`,
      resource: FAKE_MCP_URL,
      scope: "read:issues",
      issParameterSupported: true,
      client: null,
    });
  });

  const refusals: [string, FakeRemoteOptions, string][] = [
    [
      "metadata for another resource",
      { resource: { resource: "https://other.example/mcp" } },
      "resource_mismatch",
    ],
    [
      "no authorization server",
      { resource: { authorization_servers: [] } },
      "discovery_failed",
    ],
    [
      "another issuer in the metadata",
      { metadata: { issuer: "https://evil.example" } },
      "issuer_mismatch",
    ],
    [
      "no S256",
      { metadata: { code_challenge_methods_supported: ["plain"] } },
      "pkce_unsupported",
    ],
    [
      "an endpoint this server may not call",
      { metadata: { token_endpoint: "http://169.254.169.254/token" } },
      "endpoint_not_allowed",
    ],
    [
      "no token endpoint",
      { metadata: { token_endpoint: undefined } },
      "discovery_failed",
    ],
  ];
  for (const [what, options, reason] of refusals) {
    test(`${what} is ${reason}`, async () => {
      const { deps: d } = deps(options);
      expect(await reasonOf(discover(d, FAKE_MCP_URL))).toBe(reason);
    });
  }

  test("a URL the policy refuses is never sent", async () => {
    const { remote, deps: d } = deps();
    expect(await reasonOf(discover(d, "http://mcp.example.com/v1/mcp"))).toBe(
      "endpoint_not_allowed",
    );
    expect(remote.requests).toHaveLength(0);
  });
});

describe("registerClient and manualAuthMethod", () => {
  const pin = async (options: FakeRemoteOptions = {}) => {
    const { deps: d } = deps(options);
    const found = await discover(d, FAKE_MCP_URL);
    return { d, pin: found.oauth?.pin as WorkspaceMcpOAuthPin };
  };

  test("a registration that hands out a secret uses the method it names", async () => {
    const { d, pin: p } = await pin({
      registration: () => ({
        status: 201,
        json: {
          client_id: "c1",
          client_secret: "example-client-value",
          token_endpoint_auth_method: "client_secret_basic",
        },
      }),
    });
    expect(
      await registerClient(d, p, "https://console.example.com/cb"),
    ).toEqual({
      client: {
        registration: "dcr",
        clientId: "c1",
        authMethod: "client_secret_basic",
      },
      clientSecret: "example-client-value",
    });
  });

  test("a registration without a client id fails", async () => {
    const { d, pin: p } = await pin({
      registration: () => ({ status: 201, json: {} }),
    });
    expect(
      await reasonOf(registerClient(d, p, "https://console.example.com/cb")),
    ).toBe("registration_failed");
  });

  test("a hand-made client sends its secret the way the server takes", async () => {
    const { pin: p } = await pin();
    expect(manualAuthMethod(p, false)).toBe("none");
    expect(manualAuthMethod(p, true)).toBe("client_secret_basic");
    expect(
      manualAuthMethod(
        { ...p, tokenEndpointAuthMethods: ["client_secret_post"] },
        true,
      ),
    ).toBe("client_secret_post");
  });
});

describe("listTools", () => {
  test("a server that sends the credential back is refused", async () => {
    const { deps: d } = deps({
      oauth: false,
      accepted: [FAKE_TOKEN],
      toolPages: [[{ name: "leak", description: `token ${FAKE_TOKEN}` }]],
    });
    expect(
      await reasonOf(
        listTools(d, {
          url: FAKE_MCP_URL,
          serverName: "tracker",
          token: FAKE_TOKEN,
        }),
      ),
    ).toBe("credential_reflected");
  });

  test("a rejected credential is unauthorized", async () => {
    const { deps: d } = deps({ oauth: false });
    expect(
      await reasonOf(
        listTools(d, {
          url: FAKE_MCP_URL,
          serverName: "tracker",
          token: FAKE_TOKEN,
        }),
      ),
    ).toBe("unauthorized");
  });

  test("a repeated name is kept once", async () => {
    const { deps: d } = deps({
      oauth: false,
      accepted: [FAKE_TOKEN],
      toolPages: [[{ name: "a" }, { name: "a" }, { description: "no name" }]],
    });
    expect(
      await listTools(d, {
        url: FAKE_MCP_URL,
        serverName: "tracker",
        token: FAKE_TOKEN,
      }),
    ).toEqual({ tools: [{ name: "a", description: null }], skipped: 2 });
  });
});

describe("exchangeCode", () => {
  const VERIFIER = "example-verifier-not-real";
  // The verifier with its first letter as a JSON escape, which a search of
  // the raw text misses.
  const ESCAPED_VERIFIER = "\\u0065xample-verifier-not-real";

  async function exchange(answer: NonNullable<FakeRemoteOptions["token"]>) {
    const { deps: d } = deps({ token: answer });
    const pin = (await discover(d, FAKE_MCP_URL)).oauth
      ?.pin as WorkspaceMcpOAuthPin;
    return exchangeCode(d, {
      pin,
      client: { registration: "dcr", clientId: "c1", authMethod: "none" },
      clientSecret: null,
      code: "example-code",
      verifier: VERIFIER,
      redirectUri: "https://console.example.com/cb",
      now: new Date(),
    });
  }

  test("an error body that escapes the verifier is still refused", async () => {
    expect(
      await reasonOf(
        exchange(() => ({
          status: 400,
          text: `{"error":"invalid_grant","hint":"${ESCAPED_VERIFIER}"}`,
        })),
      ),
    ).toBe("credential_reflected");
  });

  test("a granted scope that carries the verifier is refused", async () => {
    for (const scope of [`read ${VERIFIER}`, ESCAPED_VERIFIER]) {
      expect(
        await reasonOf(
          exchange(() => ({
            status: 200,
            text: `{"access_token":"a1","token_type":"Bearer","scope":"${scope}"}`,
          })),
        ),
      ).toBe("credential_reflected");
    }
  });

  test("an OAuth error code outside RFC 6749's characters is not repeated", async () => {
    try {
      await exchange(() => ({
        status: 400,
        json: { error: 'bad"code' },
      }));
      throw new Error("answered normally");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceMcpRemoteError);
      const refused = error as WorkspaceMcpRemoteError;
      expect(refused.oauthError).toBeNull();
      expect(refused.message).toBe("The token endpoint answered 400");
    }
  });
});
