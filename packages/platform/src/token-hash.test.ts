import { describe, expect, test } from "bun:test";
import { hashJudgmentToken } from "./sessions/achievements/judgment-token.ts";
import { hashTitleToken } from "./sessions/session-titler.ts";
import { hashToken } from "./token-hash.ts";
import { hashWorkerToken } from "./workers/worker-gateway.ts";

describe("hashToken", () => {
  // Stored token columns hold these bytes; a change here orphans every row.
  test("is the SHA-256 of the token's UTF-8 bytes", () => {
    expect(Buffer.from(hashToken("abc")).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(Buffer.from(hashToken("é")).toString("hex")).toBe(
      new Bun.CryptoHasher("sha256")
        .update(new Uint8Array([0xc3, 0xa9]))
        .digest("hex"),
    );
  });

  test("the per-domain names are the same function", () => {
    for (const alias of [hashWorkerToken, hashTitleToken, hashJudgmentToken]) {
      expect(alias).toBe(hashToken);
    }
  });
});
