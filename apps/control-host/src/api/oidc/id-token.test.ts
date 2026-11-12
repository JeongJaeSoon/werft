import { beforeAll, describe, expect, test } from "bun:test";
import type { SigningAlg } from "./discovery.ts";
import { OidcRejectedError, type OidcRejection } from "./errors.ts";
import { verifyIdToken } from "./id-token.ts";
import { type Jwk, selectKey } from "./jwks.ts";
import {
  CLIENT_ID,
  ISSUER,
  makeSigner,
  type Signer,
} from "./test-support/fake-provider.ts";

const NOW = 1_800_000_000_000;
const NOW_SECONDS = NOW / 1000;
const NONCE = "nonce-of-this-flow";

let rsa: Signer;
let ec: Signer;
beforeAll(async () => {
  rsa = await makeSigner("RS256");
  ec = await makeSigner("ES256");
});

function claimsWith(overrides: Record<string, unknown> = {}) {
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "subject-1",
    iat: NOW_SECONDS - 2,
    exp: NOW_SECONDS + 300,
    nonce: NONCE,
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === null) delete claims[name];
  }
  return claims;
}

function verify(
  token: string,
  overrides: {
    keys?: Jwk[];
    algs?: SigningAlg[];
    issuers?: string[];
  } = {},
) {
  return verifyIdToken(token, {
    keys: overrides.keys ?? [rsa.jwk, ec.jwk],
    algs: overrides.algs ?? ["RS256", "ES256"],
    issuers: overrides.issuers ?? [ISSUER],
    clientId: CLIENT_ID,
    nonce: NONCE,
    now: () => NOW,
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

describe("id_token verification", () => {
  test("an RS256 and an ES256 token with good claims are accepted", async () => {
    expect(await verify(await rsa.sign(claimsWith()))).toMatchObject({
      sub: "subject-1",
    });
    expect(await verify(await ec.sign(claimsWith()))).toMatchObject({
      sub: "subject-1",
    });
  });

  test("a one-element audience array, a matching azp and an nbf in the past are accepted", async () => {
    expect(
      await reasonOf(
        verify(
          await rsa.sign(
            claimsWith({
              aud: [CLIENT_ID],
              azp: CLIENT_ID,
              nbf: NOW_SECONDS - 10,
            }),
          ),
        ),
      ),
    ).toBe("ok");
  });

  test("the provider's clock may run up to a minute ahead for iat and nbf", async () => {
    expect(
      await reasonOf(
        verify(
          await rsa.sign(
            claimsWith({ iat: NOW_SECONDS + 59, nbf: NOW_SECONDS + 59 }),
          ),
        ),
      ),
    ).toBe("ok");
  });

  test("the clock is read once the signature holds: a token that expired while it was checked is refused", async () => {
    const token = await rsa.sign(claimsWith({ exp: NOW_SECONDS + 1 }));
    let clock = NOW;
    const subtle = crypto.subtle;
    const original = subtle.verify;
    subtle.verify = async function (
      this: SubtleCrypto,
      ...args: Parameters<SubtleCrypto["verify"]>
    ) {
      const held = await original.apply(this, args);
      clock = NOW + 1200;
      return held;
    };
    try {
      expect(
        await reasonOf(
          verifyIdToken(token, {
            keys: [rsa.jwk],
            algs: ["RS256"],
            issuers: [ISSUER],
            clientId: CLIENT_ID,
            nonce: NONCE,
            now: () => clock,
          }),
        ),
      ).toBe("expired");
    } finally {
      subtle.verify = original;
    }
    // Read in time, the same token is good.
    expect(await reasonOf(verify(token))).toBe("ok");
  });

  const claimRefusals: [string, Record<string, unknown>, OidcRejection][] = [
    ["another issuer", { iss: "https://evil.example" }, "issuer_mismatch"],
    ["no issuer", { iss: null }, "issuer_mismatch"],
    ["another audience", { aud: "someone-else" }, "audience_mismatch"],
    ["no audience", { aud: null }, "audience_mismatch"],
    [
      "this client among other audiences",
      { aud: [CLIENT_ID, "someone-else"], azp: CLIENT_ID },
      "audience_mismatch",
    ],
    ["an empty audience array", { aud: [] }, "audience_mismatch"],
    [
      "another authorized party",
      { azp: "someone-else" },
      "authorized_party_mismatch",
    ],
    ["an expired token", { exp: NOW_SECONDS - 1 }, "expired"],
    ["a token expiring this instant", { exp: NOW_SECONDS }, "expired"],
    ["no exp", { exp: null }, "expired"],
    ["an exp that is not a number", { exp: "9999999999" }, "expired"],
    ["no iat", { iat: null }, "issued_at_invalid"],
    ["an iat that is not a number", { iat: "now" }, "issued_at_invalid"],
    [
      "an iat more than a minute ahead",
      { iat: NOW_SECONDS + 61 },
      "issued_at_invalid",
    ],
    [
      "an iat older than the flow could be",
      { iat: NOW_SECONDS - 11 * 60 - 1 },
      "issued_at_invalid",
    ],
    ["an nbf still ahead", { nbf: NOW_SECONDS + 61 }, "not_yet_valid"],
    ["an nbf that is not a number", { nbf: "soon" }, "not_yet_valid"],
    ["another nonce", { nonce: "replayed" }, "nonce_mismatch"],
    ["no nonce", { nonce: null }, "nonce_mismatch"],
    ["an empty subject", { sub: "" }, "subject_invalid"],
    ["no subject", { sub: null }, "subject_invalid"],
    ["a subject that is not text", { sub: 42 }, "subject_invalid"],
    ["an overlong subject", { sub: "s".repeat(256) }, "subject_invalid"],
  ];
  for (const [what, overrides, reason] of claimRefusals) {
    test(`refuses ${what} as ${reason}`, async () => {
      expect(
        await reasonOf(verify(await rsa.sign(claimsWith(overrides)))),
      ).toBe(reason);
    });
  }

  test("Google's scheme-less issuer passes only when the caller lists it", async () => {
    const token = await rsa.sign(claimsWith({ iss: "accounts.google.com" }));
    expect(await reasonOf(verify(token))).toBe("issuer_mismatch");
    expect(
      await reasonOf(
        verify(token, {
          issuers: ["https://accounts.google.com", "accounts.google.com"],
        }),
      ),
    ).toBe("ok");
  });

  test("a signature by another key, or a payload changed after signing, is refused", async () => {
    const other = await makeSigner("RS256");
    const forged = await other.sign(claimsWith(), { kid: rsa.kid });
    expect(await reasonOf(verify(forged))).toBe("bad_signature");

    const [header, , signature] = (await rsa.sign(claimsWith())).split(".");
    const swapped = Buffer.from(
      JSON.stringify(claimsWith({ sub: "someone-else" })),
    ).toString("base64url");
    expect(await reasonOf(verify(`${header}.${swapped}.${signature}`))).toBe(
      "bad_signature",
    );
  });

  test("an unsigned or symmetric algorithm is never accepted", async () => {
    const body = Buffer.from(JSON.stringify(claimsWith())).toString(
      "base64url",
    );
    for (const alg of ["none", "HS256", "PS256"]) {
      const header = Buffer.from(
        JSON.stringify({ alg, kid: rsa.kid }),
      ).toString("base64url");
      expect(await reasonOf(verify(`${header}.${body}.c2ln`))).toBe(
        "alg_not_allowed",
      );
    }
  });

  test("an algorithm the provider does not sign with is refused even with a fitting key", async () => {
    expect(
      await reasonOf(verify(await ec.sign(claimsWith()), { algs: ["RS256"] })),
    ).toBe("alg_not_allowed");
  });

  test("a malformed token is refused", async () => {
    const good = await rsa.sign(claimsWith());
    const critical = await rsa.sign(claimsWith(), { crit: ["exp"] });
    for (const token of [
      "",
      "one.two",
      `${good}.extra`,
      "!!!.###.$$$",
      critical,
    ]) {
      expect(await reasonOf(verify(token))).toBe("malformed_token");
    }
  });

  describe("key selection and rotation", () => {
    test("a token signed with a key the provider has rotated in is accepted, one it rotated out is not", async () => {
      const next = await makeSigner("RS256");
      const oldToken = await rsa.sign(claimsWith());
      const newToken = await next.sign(claimsWith());
      // Before rotation the provider publishes only the old key.
      expect(await reasonOf(verify(newToken, { keys: [rsa.jwk] }))).toBe(
        "no_matching_key",
      );
      // During rotation both verify.
      const both = { keys: [rsa.jwk, next.jwk] };
      expect(await reasonOf(verify(oldToken, both))).toBe("ok");
      expect(await reasonOf(verify(newToken, both))).toBe("ok");
      // After it the old key is gone at once: nothing is cached.
      expect(await reasonOf(verify(oldToken, { keys: [next.jwk] }))).toBe(
        "no_matching_key",
      );
      expect(await reasonOf(verify(newToken, { keys: [next.jwk] }))).toBe("ok");
    });

    test("a token without a kid is accepted only while a single key fits", async () => {
      const token = await rsa.sign(claimsWith(), { kid: undefined });
      expect(await reasonOf(verify(token, { keys: [rsa.jwk, ec.jwk] }))).toBe(
        "ok",
      );
      const second = await makeSigner("RS256");
      expect(
        await reasonOf(verify(token, { keys: [rsa.jwk, second.jwk] })),
      ).toBe("no_matching_key");
    });

    test("a key is passed over when it is for encryption, for another algorithm, of another type or too short", async () => {
      const header = { alg: "RS256" as const, kid: rsa.kid };
      expect(selectKey([rsa.jwk], header)).toBe(rsa.jwk);
      expect(selectKey([{ ...rsa.jwk, use: "enc" }], header)).toBeNull();
      expect(selectKey([{ ...rsa.jwk, alg: "RS512" }], header)).toBeNull();
      expect(selectKey([{ ...rsa.jwk, kid: "other" }], header)).toBeNull();
      expect(selectKey([{ ...ec.jwk, kid: rsa.kid }], header)).toBeNull();
      expect(
        selectKey([{ ...ec.jwk, crv: "P-384" }], {
          alg: "ES256",
          kid: ec.kid,
        }),
      ).toBeNull();
      // Two keys under one kid do not say which one signed.
      expect(selectKey([rsa.jwk, { ...rsa.jwk }], header)).toBeNull();
      // A key that states neither use nor alg is still a signing key.
      const { use: _use, alg: _alg, ...bare } = rsa.jwk;
      expect(selectKey([bare], header)).toBe(bare);

      // The length is counted in bits, not bytes: 2041 bits fill 256 bytes.
      const modulus = (topByte: number) =>
        Buffer.from([topByte, ...new Array<number>(255).fill(0xff)]).toString(
          "base64url",
        );
      const sized = (topByte: number) => ({ ...rsa.jwk, n: modulus(topByte) });
      expect(selectKey([sized(0x01)], header)).toBeNull();
      expect(selectKey([sized(0x7f)], header)).toBeNull();
      const full = sized(0x80);
      expect(selectKey([full], header)).toBe(full);
      // Leading zero bytes add no length.
      const padded = {
        ...rsa.jwk,
        n: Buffer.concat([
          Buffer.from([0]),
          Buffer.from(modulus(0x01), "base64url"),
        ]).toString("base64url"),
      };
      expect(selectKey([padded], header)).toBeNull();

      const short = await makeSigner("RS256", 1024);
      expect(
        selectKey([short.jwk], { alg: "RS256", kid: short.kid }),
      ).toBeNull();
      expect(
        await reasonOf(
          verify(await short.sign(claimsWith()), { keys: [short.jwk] }),
        ),
      ).toBe("no_matching_key");
    });
  });
});
