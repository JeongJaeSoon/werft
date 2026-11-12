import type { SigningAlg } from "./discovery.ts";
import { OidcUnavailableError } from "./errors.ts";
import {
  type NetworkPolicy,
  type ProviderRequest,
  providerRequest,
} from "./provider-http.ts";

export type Jwk = Record<string, unknown>;

const MIN_RSA_BITS = 2048;

/** The provider's current signing keys, fetched now and never cached. */
export async function fetchJwks(
  jwksUri: string,
  policy: NetworkPolicy,
  request: ProviderRequest = providerRequest,
): Promise<Jwk[]> {
  const response = await request(
    jwksUri,
    { headers: { Accept: "application/json" } },
    policy,
  );
  if (response.status !== 200) {
    throw new OidcUnavailableError(
      "answered",
      `JWKS answered ${response.status}`,
    );
  }
  try {
    const { keys } = JSON.parse(response.text) as { keys?: unknown };
    if (!Array.isArray(keys)) throw new Error("no keys");
    return keys.filter(
      (key): key is Jwk => typeof key === "object" && key !== null,
    );
  } catch {
    throw new OidcUnavailableError("answered", "JWKS document is invalid");
  }
}

function rsaBits(modulus: unknown): number {
  if (typeof modulus !== "string") return 0;
  const bytes = Buffer.from(modulus, "base64url");
  const leading = bytes.findIndex((byte) => byte !== 0);
  if (leading === -1) return 0;
  // Counted to the top set bit: a modulus of 2041 bits fills 256 bytes too.
  const zeroBitsInTopByte = Math.clz32(bytes[leading] as number) - 24;
  return (bytes.length - leading) * 8 - zeroBitsInTopByte;
}

function fits(key: Jwk, alg: SigningAlg): boolean {
  if (key.use !== undefined && key.use !== "sig") return false;
  if (key.alg !== undefined && key.alg !== alg) return false;
  if (alg === "RS256") {
    return (
      key.kty === "RSA" &&
      typeof key.e === "string" &&
      rsaBits(key.n) >= MIN_RSA_BITS
    );
  }
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string"
  );
}

/**
 * The one key the token's header names. Null when none fits, and also when
 * more than one does: a token that does not say which key signed it is only
 * accepted while the provider publishes a single fitting key.
 */
export function selectKey(
  keys: readonly Jwk[],
  header: { alg: SigningAlg; kid?: string },
): Jwk | null {
  const candidates = keys.filter(
    (key) =>
      fits(key, header.alg) &&
      (header.kid === undefined || key.kid === header.kid),
  );
  return candidates.length === 1 ? (candidates[0] as Jwk) : null;
}
