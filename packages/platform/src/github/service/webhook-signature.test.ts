import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { githubSignatureMatches } from "./webhook-signature.ts";

const SECRET = "s".repeat(32);

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("the webhook signature", () => {
  test("is HMAC-SHA256 of the raw body under the secret", () => {
    const body = new TextEncoder().encode("{}");
    expect(githubSignatureMatches(SECRET, body, sign("{}"))).toBe(true);
    expect(
      githubSignatureMatches(SECRET, body, sign("{}", "x".repeat(32))),
    ).toBe(false);
    expect(githubSignatureMatches(SECRET, body, sign("{ }"))).toBe(false);
    for (const malformed of ["", "sha1=abc", `sha256=${"0".repeat(63)}`]) {
      expect(githubSignatureMatches(SECRET, body, malformed)).toBe(false);
    }
  });
});
