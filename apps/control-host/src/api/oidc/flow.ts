import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "@werft-ai/contracts";
import type { OidcEndpoints, TokenAuthMethod } from "./discovery.ts";
import { OidcRejectedError } from "./errors.ts";
import { type IdTokenClaims, verifyIdToken } from "./id-token.ts";
import { fetchJwks } from "./jwks.ts";
import {
  type NetworkPolicy,
  type ProviderRequest,
  providerRequest,
} from "./provider-http.ts";

export type OidcClient = {
  clientId: string;
  clientSecret: string;
  tokenAuthMethod: TokenAuthMethod;
  redirectUri: string;
};

export type OidcFlowStart = {
  authorizationUrl: string;
  /** The three values the browser must bring back; never logged. */
  state: string;
  nonce: string;
  verifier: string;
};

/** Who the provider says signed in, after every check passed. */
export type OidcIdentity = {
  issuer: string;
  subject: string;
  /** Normalized. Null when the provider gave none. */
  email: string | null;
  /** The provider's own word; null when it did not say. */
  emailVerified: boolean | null;
  name: string | null;
  /** The verified id_token claims, for the per-issuer rules. */
  claims: IdTokenClaims;
};

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The authorization request: always a code flow with PKCE S256. */
export function startFlow(input: {
  endpoints: OidcEndpoints;
  client: OidcClient;
  extraParams?: Record<string, string>;
}): OidcFlowStart {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const url = new URL(input.endpoints.authorizationEndpoint);
  // The provider's own query parameters stay; ours win on a clash.
  const query = url.searchParams;
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...input.extraParams,
  })) {
    query.set(name, value);
  }
  return { authorizationUrl: url.toString(), state, nonce, verifier };
}

/**
 * Exchanges the code and verifies what comes back. The caller has already
 * matched `state` against the browser's flow. Throws OidcRejectedError or
 * OidcUnavailableError.
 */
export async function finishFlow(input: {
  endpoints: OidcEndpoints;
  client: OidcClient;
  /** Every spelling of the issuer accepted in the id_token. */
  issuers: readonly string[];
  code: string;
  /** `iss` from the authorization response, when the provider sent one. */
  responseIssuer?: string;
  nonce: string;
  verifier: string;
  /** Refuse a sign-in the provider does not mark as a verified address. */
  requireVerifiedEmail: boolean;
  policy: NetworkPolicy;
  /**
   * The clock, in milliseconds. Read after the provider has answered, so a
   * token that expired while this server waited is expired.
   */
  now: () => number;
  request?: ProviderRequest;
}): Promise<OidcIdentity> {
  const { endpoints, client, policy } = input;
  const request = input.request ?? providerRequest;
  if (
    input.responseIssuer === undefined
      ? endpoints.issParameterRequired
      : input.responseIssuer !== endpoints.issuer
  ) {
    throw new OidcRejectedError(
      "response_issuer_mismatch",
      "Authorization response is not from this issuer",
    );
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: client.redirectUri,
    code_verifier: input.verifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.tokenAuthMethod === "client_secret_basic") {
    // RFC 6749 2.3.1: each half is form-encoded before the Basic encoding.
    const pair = [client.clientId, client.clientSecret]
      .map((half) => new URLSearchParams({ v: half }).toString().slice(2))
      .join(":");
    headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    form.set("client_secret", client.clientSecret);
  }
  const tokenResponse = await request(
    endpoints.tokenEndpoint,
    { method: "POST", headers, body: form.toString() },
    policy,
  );
  if (!isSuccess(tokenResponse.status)) {
    throw new OidcRejectedError(
      "code_refused",
      `Token endpoint refused the code (${tokenResponse.status})`,
    );
  }
  const tokens = parseObject(tokenResponse.text);
  if (typeof tokens?.id_token !== "string") {
    throw new OidcRejectedError(
      "no_id_token",
      "Token response has no id_token",
    );
  }

  // Asked for only now, after the code was accepted: a caller without a
  // valid code cannot make this server fetch keys.
  const keys = await fetchJwks(endpoints.jwksUri, policy, request);
  const claims = await verifyIdToken(tokens.id_token, {
    keys,
    algs: endpoints.signingAlgs,
    issuers: input.issuers,
    clientId: client.clientId,
    nonce: input.nonce,
    now: input.now,
  });
  // The signed token's "not verified" stands: UserInfo below fills in what
  // the token leaves out and never overrules what it says.
  if (claims.email_verified === false) {
    throw new OidcRejectedError(
      "email_unverified",
      "Provider says the email is not verified",
    );
  }

  let email = claims.email;
  let emailVerified = claims.email_verified;
  if (
    typeof email !== "string" &&
    endpoints.userinfoEndpoint !== null &&
    typeof tokens.access_token === "string"
  ) {
    // Some providers keep the id_token thin and serve the scope's claims
    // from UserInfo. Its answer is only about the same subject.
    const userinfoResponse = await request(
      endpoints.userinfoEndpoint,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
        },
      },
      policy,
    );
    // The wait for UserInfo counts: the sign-in ends on a live token.
    if ((claims.exp as number) <= input.now() / 1000) {
      throw new OidcRejectedError(
        "expired",
        "id_token expired before the sign-in finished",
      );
    }
    const userinfo = isSuccess(userinfoResponse.status)
      ? parseObject(userinfoResponse.text)
      : null;
    if (!userinfo) {
      throw new OidcRejectedError(
        "userinfo_refused",
        `UserInfo did not answer with claims (${userinfoResponse.status})`,
      );
    }
    if (userinfo.sub !== claims.sub) {
      throw new OidcRejectedError(
        "userinfo_subject_mismatch",
        "UserInfo is about another subject",
      );
    }
    email = userinfo.email;
    emailVerified = userinfo.email_verified;
  }
  const address =
    typeof email === "string" && email.trim() !== ""
      ? normalizeEmail(email)
      : null;
  const verified = typeof emailVerified === "boolean" ? emailVerified : null;
  // A provider that says "not verified" is believed whatever the setting.
  if (
    verified === false ||
    (input.requireVerifiedEmail && (address === null || verified !== true))
  ) {
    throw new OidcRejectedError(
      "email_unverified",
      "Provider does not vouch for a verified email",
    );
  }
  return {
    issuer: endpoints.issuer,
    subject: claims.sub as string,
    email: address,
    emailVerified: verified,
    name: typeof claims.name === "string" ? claims.name : null,
    claims,
  };
}
