import { describe, expect, test } from "bun:test";
import { discover } from "./discovery.ts";
import {
  type DiscoveryProblem,
  OidcDiscoveryError,
  OidcUnavailableError,
} from "./errors.ts";
import type { NetworkPolicy, ProviderRequest } from "./provider-http.ts";
import { discoveryDocument, ISSUER } from "./test-support/fake-provider.ts";

const REFUSE: NetworkPolicy = { plainHttp: "refuse" };

function answering(
  document: unknown,
  status = 200,
): { request: ProviderRequest; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    request: async (url) => {
      urls.push(url);
      return {
        status,
        text:
          typeof document === "string" ? document : JSON.stringify(document),
      };
    },
  };
}

async function problemOf(
  document: unknown,
  issuer = ISSUER,
  policy = REFUSE,
): Promise<DiscoveryProblem | "accepted"> {
  try {
    await discover(issuer, policy, answering(document).request);
  } catch (error) {
    if (error instanceof OidcDiscoveryError) return error.problem;
    throw error;
  }
  return "accepted";
}

describe("OIDC discovery", () => {
  test("a complete document is reduced to what this client can use", async () => {
    const { request, urls } = answering(discoveryDocument());
    expect(await discover(ISSUER, REFUSE, request)).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
      userinfoEndpoint: `${ISSUER}/userinfo`,
      signingAlgs: ["RS256", "ES256"],
      tokenAuthMethods: ["client_secret_basic", "client_secret_post"],
      issParameterRequired: false,
      pkceAdvertised: true,
    });
    expect(urls).toEqual([`${ISSUER}/.well-known/openid-configuration`]);
  });

  test("the issuer's trailing slash is dropped only to build the discovery URL", async () => {
    const issuer = "https://idp.example/realms/a/";
    const { request, urls } = answering(discoveryDocument({ issuer }));
    expect((await discover(issuer, REFUSE, request)).issuer).toBe(issuer);
    expect(urls).toEqual([
      "https://idp.example/realms/a/.well-known/openid-configuration",
    ]);
  });

  test("optional parts fall back: no UserInfo, basic auth by default, PKCE not advertised, iss parameter", async () => {
    const { request } = answering(
      discoveryDocument({
        userinfo_endpoint: undefined,
        token_endpoint_auth_methods_supported: undefined,
        code_challenge_methods_supported: undefined,
        id_token_signing_alg_values_supported: ["PS256", "ES256"],
        authorization_response_iss_parameter_supported: true,
      }),
    );
    expect(await discover(ISSUER, REFUSE, request)).toMatchObject({
      userinfoEndpoint: null,
      tokenAuthMethods: ["client_secret_basic"],
      pkceAdvertised: false,
      signingAlgs: ["ES256"],
      issParameterRequired: true,
    });
  });

  const refused: [
    string,
    Record<string, unknown> | string,
    DiscoveryProblem,
  ][] = [
    ["another issuer", { issuer: "https://evil.example" }, "issuer_mismatch"],
    [
      "an issuer that differs by a trailing slash",
      { issuer: `${ISSUER}/` },
      "issuer_mismatch",
    ],
    [
      "a tenant-template issuer",
      { issuer: "https://login.example/{tenantid}/v2.0" },
      "issuer_mismatch",
    ],
    ["no token endpoint", { token_endpoint: undefined }, "invalid_document"],
    ["a relative JWKS URI", { jwks_uri: "/jwks" }, "invalid_document"],
    [
      "a plain-http token endpoint",
      { token_endpoint: "http://idp.example/token" },
      "insecure_endpoint",
    ],
    [
      "a plain-http authorization endpoint",
      { authorization_endpoint: "http://idp.example/authorize" },
      "insecure_endpoint",
    ],
    [
      "a plain-http JWKS URI",
      { jwks_uri: "http://169.254.169.254/jwks" },
      "insecure_endpoint",
    ],
    [
      "a plain-http UserInfo endpoint",
      { userinfo_endpoint: "http://idp.example/userinfo" },
      "insecure_endpoint",
    ],
    [
      "an endpoint with credentials in it",
      { token_endpoint: "https://a:b@idp.example/token" },
      "invalid_document",
    ],
    [
      "no code flow",
      { response_types_supported: ["id_token"] },
      "unsupported_flow",
    ],
    [
      "no response types at all",
      { response_types_supported: undefined },
      "unsupported_flow",
    ],
    [
      "only symmetric or unsigned id_tokens",
      { id_token_signing_alg_values_supported: ["HS256", "none"] },
      "unsupported_algorithm",
    ],
    [
      "only client authentication this client does not do",
      { token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] },
      "unsupported_client_auth",
    ],
    [
      "PKCE without S256",
      { code_challenge_methods_supported: ["plain"] },
      "pkce_s256_unsupported",
    ],
    ["a body that is not JSON", "<html>", "invalid_document"],
    ["a JSON array", "[]", "invalid_document"],
  ];
  for (const [what, overrides, problem] of refused) {
    test(`refuses ${what} as ${problem}`, async () => {
      expect(
        await problemOf(
          typeof overrides === "string"
            ? overrides
            : discoveryDocument(overrides),
        ),
      ).toBe(problem);
    });
  }

  test("a plain-http issuer is refused before any request, except on loopback where allowed", async () => {
    const { request, urls } = answering(discoveryDocument());
    await expect(
      discover("http://idp.example", REFUSE, request),
    ).rejects.toMatchObject({ problem: "insecure_endpoint" });
    await expect(discover("not a url", REFUSE, request)).rejects.toMatchObject({
      problem: "invalid_document",
    });
    expect(urls).toEqual([]);

    const local = "http://localhost:8080/realms/a";
    const document = discoveryDocument({
      issuer: local,
      authorization_endpoint: `${local}/auth`,
      token_endpoint: `${local}/token`,
      jwks_uri: `${local}/certs`,
      userinfo_endpoint: `${local}/userinfo`,
    });
    expect(await problemOf(document, local, { plainHttp: "loopback" })).toBe(
      "accepted",
    );
    expect(await problemOf(document, local, REFUSE)).toBe("insecure_endpoint");
  });

  test("an answer other than 200 is unavailable, not a verdict on the document", async () => {
    await expect(
      discover(ISSUER, REFUSE, answering({}, 404).request),
    ).rejects.toBeInstanceOf(OidcUnavailableError);
  });
});
