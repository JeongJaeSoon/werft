import { createHash, randomBytes } from "node:crypto";
import type { SigningAlg } from "../discovery.ts";
import type { Jwk } from "../jwks.ts";
import type { ProviderRequest, ProviderResponse } from "../provider-http.ts";

export type Signer = {
  alg: SigningAlg;
  kid: string;
  /** The public key as the provider would publish it. */
  jwk: Jwk;
  sign(
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ): Promise<string>;
};

const encode = (part: unknown) =>
  Buffer.from(JSON.stringify(part)).toString("base64url");

export async function makeSigner(
  alg: SigningAlg = "RS256",
  modulusLength = 2048,
): Promise<Signer> {
  const generate =
    alg === "RS256"
      ? {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        }
      : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await crypto.subtle.generateKey(generate, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const kid = randomBytes(8).toString("hex");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    alg,
    kid,
    jwk: { ...exported, kid, alg, use: "sig", key_ops: undefined },
    async sign(claims, header = {}) {
      const signed = `${encode({ alg, typ: "JWT", kid, ...header })}.${encode(claims)}`;
      const signature = await crypto.subtle.sign(
        alg === "RS256"
          ? { name: "RSASSA-PKCS1-v1_5" }
          : { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(signed),
      );
      return `${signed}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

export const ISSUER = "https://idp.example";
export const CLIENT_ID = "client-1";
export const CLIENT_SECRET = "client-secret-value";
export const REDIRECT_URI = "https://werft.example/auth/callback/p1";

export function discoveryDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    response_types_supported: ["code"],
    id_token_signing_alg_values_supported: ["RS256", "ES256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

export type FakeProvider = {
  request: ProviderRequest;
  /** Every request the client sent, in order. */
  calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[];
  /** Keys the JWKS endpoint serves now. */
  keys: Jwk[];
  /** What the next token exchange returns in the id_token. */
  claims: Record<string, unknown>;
  signer: Signer;
  tokenHeader: Record<string, unknown>;
  userinfo: Record<string, unknown> | null;
  /** Check the PKCE verifier against the challenge, as a strict provider. */
  challenge: string | null;
};

/**
 * A provider that lives in the request function: discovery, token, JWKS and
 * UserInfo answers a test can bend one field at a time.
 */
export async function fakeProvider(
  options: { discovery?: Record<string, unknown>; signer?: Signer } = {},
): Promise<FakeProvider> {
  const signer = options.signer ?? (await makeSigner());
  const provider: FakeProvider = {
    calls: [],
    keys: [signer.jwk],
    claims: {},
    signer,
    tokenHeader: {},
    userinfo: null,
    challenge: null,
    request: async (url, init) => {
      const body = init.body ?? "";
      provider.calls.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
        body,
      });
      const json = (value: unknown, status = 200): ProviderResponse => ({
        status,
        text: JSON.stringify(value),
      });
      const path = new URL(url).pathname;
      if (path === "/.well-known/openid-configuration") {
        return json(discoveryDocument(options.discovery));
      }
      if (path === "/jwks") return json({ keys: provider.keys });
      if (path === "/userinfo") {
        return provider.userinfo
          ? json(provider.userinfo)
          : json({ error: "invalid_token" }, 401);
      }
      if (path === "/token") {
        const form = new URLSearchParams(body);
        const basic = init.headers?.Authorization?.replace(/^Basic /, "");
        const [id, secret] = basic
          ? Buffer.from(basic, "base64")
              .toString("utf8")
              .split(":")
              .map((half) => decodeURIComponent(half))
          : [form.get("client_id"), form.get("client_secret")];
        const verifier = form.get("code_verifier") ?? "";
        if (
          id !== CLIENT_ID ||
          secret !== CLIENT_SECRET ||
          form.get("code") !== "good-code" ||
          form.get("redirect_uri") !== REDIRECT_URI ||
          (provider.challenge !== null &&
            createHash("sha256").update(verifier).digest("base64url") !==
              provider.challenge)
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json({
          access_token: "access-token-value",
          token_type: "Bearer",
          id_token: await provider.signer.sign(
            provider.claims,
            provider.tokenHeader,
          ),
        });
      }
      return json({ error: "not_found" }, 404);
    },
  };
  return provider;
}
