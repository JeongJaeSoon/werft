import { OidcDiscoveryError, OidcUnavailableError } from "./errors.ts";
import {
  endpointProblem,
  type NetworkPolicy,
  type ProviderRequest,
  providerRequest,
} from "./provider-http.ts";

export const SIGNING_ALGS = ["RS256", "ES256"] as const;
export type SigningAlg = (typeof SIGNING_ALGS)[number];

export const TOKEN_AUTH_METHODS = [
  "client_secret_basic",
  "client_secret_post",
] as const;
export type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

/** What a discovery document says, reduced to what this client can use. */
export type OidcEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  /** Never empty. */
  signingAlgs: SigningAlg[];
  /** Never empty; the first is the default. */
  tokenAuthMethods: TokenAuthMethod[];
  /** The provider adds `iss` to the authorization response (RFC 9207). */
  issParameterRequired: boolean;
  /** False when the provider does not say which PKCE methods it takes. */
  pkceAdvertised: boolean;
};

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

/**
 * Reads and checks the provider's discovery document. Throws
 * OidcDiscoveryError for a document this client cannot work with, and
 * OidcUnavailableError when there was no document to read.
 */
export async function discover(
  issuer: string,
  policy: NetworkPolicy,
  request: ProviderRequest = providerRequest,
): Promise<OidcEndpoints> {
  const issuerProblem = endpointProblem(issuer, policy);
  if (issuerProblem !== null) {
    throw new OidcDiscoveryError(
      issuerProblem === "invalid_url" ? "invalid_document" : issuerProblem,
      "Issuer is not a URL this client may use",
    );
  }
  const response = await request(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    { headers: { Accept: "application/json" } },
    policy,
  );
  if (response.status !== 200) {
    throw new OidcUnavailableError(
      "answered",
      `OIDC discovery answered ${response.status}`,
    );
  }
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(response.text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    document = parsed as Record<string, unknown>;
  } catch {
    throw new OidcDiscoveryError(
      "invalid_document",
      "OIDC discovery document is not a JSON object",
    );
  }
  if (document.issuer !== issuer) {
    throw new OidcDiscoveryError(
      "issuer_mismatch",
      "OIDC discovery names another issuer",
    );
  }

  const endpoint = (name: string, optional = false): string | null => {
    const value = document[name];
    if (value === undefined && optional) return null;
    const problem = endpointProblem(value, policy);
    if (problem !== null) {
      throw new OidcDiscoveryError(
        problem === "invalid_url" ? "invalid_document" : problem,
        `OIDC discovery ${name} is not a URL this client may use`,
      );
    }
    return value as string;
  };
  const authorizationEndpoint = endpoint("authorization_endpoint") as string;
  const tokenEndpoint = endpoint("token_endpoint") as string;
  const jwksUri = endpoint("jwks_uri") as string;
  const userinfoEndpoint = endpoint("userinfo_endpoint", true);

  if (!stringList(document.response_types_supported)?.includes("code")) {
    throw new OidcDiscoveryError(
      "unsupported_flow",
      "Provider does not offer the authorization code flow",
    );
  }
  const offeredAlgs = stringList(
    document.id_token_signing_alg_values_supported,
  );
  const signingAlgs = SIGNING_ALGS.filter((alg) => offeredAlgs?.includes(alg));
  if (signingAlgs.length === 0) {
    throw new OidcDiscoveryError(
      "unsupported_algorithm",
      "Provider signs id_tokens with no algorithm this client accepts",
    );
  }
  // The specification's default when the provider does not say.
  const offeredAuth =
    document.token_endpoint_auth_methods_supported === undefined
      ? ["client_secret_basic"]
      : stringList(document.token_endpoint_auth_methods_supported);
  const tokenAuthMethods = TOKEN_AUTH_METHODS.filter((method) =>
    offeredAuth?.includes(method),
  );
  if (tokenAuthMethods.length === 0) {
    throw new OidcDiscoveryError(
      "unsupported_client_auth",
      "Provider takes no client secret authentication this client offers",
    );
  }
  const pkceMethods = document.code_challenge_methods_supported;
  if (pkceMethods !== undefined && !stringList(pkceMethods)?.includes("S256")) {
    throw new OidcDiscoveryError(
      "pkce_s256_unsupported",
      "Provider does not take PKCE S256",
    );
  }

  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    userinfoEndpoint,
    signingAlgs,
    tokenAuthMethods,
    issParameterRequired:
      document.authorization_response_iss_parameter_supported === true,
    pkceAdvertised: pkceMethods !== undefined,
  };
}
