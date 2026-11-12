import { sameString } from "../same-string.ts";
import { SIGNING_ALGS, type SigningAlg } from "./discovery.ts";
import { OidcRejectedError } from "./errors.ts";
import { type Jwk, selectKey } from "./jwks.ts";

export type IdTokenClaims = Record<string, unknown>;

/** How far the provider's clock may run ahead of this one. */
const CLOCK_SKEW_SECONDS = 60;
/**
 * The flow lives ten minutes and the token is minted when the code is
 * exchanged, so an older one was not minted for this flow.
 */
const MAX_AGE_SECONDS = 11 * 60;
const MAX_SUBJECT_LENGTH = 255;

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function signatureHolds(
  key: Jwk,
  alg: SigningAlg,
  signed: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    // Only the key material goes in: `use`, `alg` and `key_ops` were judged
    // by selectKey and would only give the import its own reasons to fail.
    const imported =
      alg === "RS256"
        ? await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: key.n as string, e: key.e as string },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          )
        : await crypto.subtle.importKey(
            "jwk",
            {
              kty: "EC",
              crv: "P-256",
              x: key.x as string,
              y: key.y as string,
            },
            { name: "ECDSA", namedCurve: "P-256" },
            false,
            ["verify"],
          );
    return await crypto.subtle.verify(
      alg === "RS256"
        ? { name: "RSASSA-PKCS1-v1_5" }
        : { name: "ECDSA", hash: "SHA-256" },
      imported,
      signature,
      new TextEncoder().encode(signed),
    );
  } catch {
    return false;
  }
}

/**
 * Verifies the signature and every claim that ties the token to this
 * client, this provider and this flow. Throws OidcRejectedError.
 */
export async function verifyIdToken(
  token: string,
  expected: {
    keys: readonly Jwk[];
    /** Algorithms this provider signs with. */
    algs: readonly SigningAlg[];
    /** Every spelling of the issuer the provider may put in `iss`. */
    issuers: readonly string[];
    clientId: string;
    nonce: string;
    /** Milliseconds. */
    now: number;
  },
): Promise<IdTokenClaims> {
  const parts = token.split(".");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = encodedHeader ? decodeJson(encodedHeader) : null;
  const claims = encodedPayload ? decodeJson(encodedPayload) : null;
  if (
    parts.length !== 3 ||
    !header ||
    !claims ||
    !encodedSignature ||
    header.crit !== undefined ||
    (header.kid !== undefined && typeof header.kid !== "string")
  ) {
    throw new OidcRejectedError("malformed_token", "id_token is malformed");
  }
  const alg = SIGNING_ALGS.find(
    (candidate) =>
      candidate === header.alg && expected.algs.includes(candidate),
  );
  if (!alg) {
    throw new OidcRejectedError(
      "alg_not_allowed",
      "id_token is signed with an algorithm this provider does not use",
    );
  }
  const key = selectKey(expected.keys, {
    alg,
    ...(typeof header.kid === "string" ? { kid: header.kid } : {}),
  });
  if (!key) {
    throw new OidcRejectedError(
      "no_matching_key",
      "id_token names no single fitting key",
    );
  }
  const held = await signatureHolds(
    key,
    alg,
    `${encodedHeader}.${encodedPayload}`,
    new Uint8Array(Buffer.from(encodedSignature, "base64url")),
  );
  if (!held) {
    throw new OidcRejectedError("bad_signature", "id_token signature is wrong");
  }

  if (
    typeof claims.iss !== "string" ||
    !expected.issuers.includes(claims.iss)
  ) {
    throw new OidcRejectedError(
      "issuer_mismatch",
      "id_token is from another issuer",
    );
  }
  // An audience this client does not know is not trusted, so the token must
  // be for this client alone.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audiences.length !== 1 || audiences[0] !== expected.clientId) {
    throw new OidcRejectedError(
      "audience_mismatch",
      "id_token is not for this client alone",
    );
  }
  if (claims.azp !== undefined && claims.azp !== expected.clientId) {
    throw new OidcRejectedError(
      "authorized_party_mismatch",
      "id_token azp is another client",
    );
  }
  const nowSeconds = expected.now / 1000;
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  // No allowance on exp: a token past its own deadline is past it.
  if (!finite(claims.exp) || claims.exp <= nowSeconds) {
    throw new OidcRejectedError("expired", "id_token is expired or has no exp");
  }
  if (
    !finite(claims.iat) ||
    claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    claims.iat < nowSeconds - MAX_AGE_SECONDS
  ) {
    throw new OidcRejectedError(
      "issued_at_invalid",
      "id_token iat is missing, in the future or too old",
    );
  }
  if (
    claims.nbf !== undefined &&
    (!finite(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)
  ) {
    throw new OidcRejectedError("not_yet_valid", "id_token is not valid yet");
  }
  if (
    typeof claims.nonce !== "string" ||
    !sameString(claims.nonce, expected.nonce)
  ) {
    throw new OidcRejectedError(
      "nonce_mismatch",
      "id_token nonce does not match",
    );
  }
  if (
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > MAX_SUBJECT_LENGTH
  ) {
    throw new OidcRejectedError(
      "subject_invalid",
      "id_token has no usable subject",
    );
  }
  return claims;
}
